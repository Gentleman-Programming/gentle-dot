//! The macOS voice backends: the native microphone (AVAudioEngine's input node, resampled to
//! 16 kHz mono, with each tap buffer passed along as it came) and Apple's Speech framework
//! (`SFSpeechRecognizer`, on-device when the locale supports it, else Apple's servers). Nothing
//! here decides policy; `machine` does.
//!
//! Apple Speech is fed the input node's own buffers (S30.6), as Apple's documented pattern
//! does: with our 16 kHz box-filtered stream it misheard speech that Parakeet decoded from the
//! same capture (L101-L102). The 16 kHz path in `AppleRecognition::feed` stays only for a
//! microphone without device buffers.
//!
//! Threads: permission handlers, the audio tap, the interruption notification, and recognition
//! results all arrive off the main thread (the recognizer gets an operation queue of its own),
//! and they only call the `Sink`. The objects below are used from the command's blocking thread
//! and from those callbacks; AVAudioEngine and the Speech request are not tied to a thread.

use super::audio::{self, Resampler, SAMPLE_RATE};
use super::core_audio;
use super::{Authorization, Microphone, NativeAudio, Recognition, Recognizer, Sink, Stream, VoiceError};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{available, msg_send, AnyThread};
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
use objc2_avf_audio::{
    AVAudioEngine, AVAudioEngineConfigurationChangeNotification, AVAudioFormat, AVAudioInputNode, AVAudioPCMBuffer, AVAudioTime,
};
use objc2_foundation::{NSError, NSLocale, NSNotification, NSNotificationCenter, NSObjectProtocol, NSOperationQueue, NSString};
use objc2_speech::{
    SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask, SFSpeechRecognizer,
    SFSpeechRecognizerAuthorizationStatus,
};
use std::cell::RefCell;
use std::panic::AssertUnwindSafe;
use std::ptr::NonNull;
use std::sync::mpsc;

/// Frames per tap callback at the device rate (about 21 ms at 48 kHz).
const TAP_FRAMES: u32 = 1_024;

/// The input node's audio unit: the object a device is chosen on. The vendored bindings gate
/// `audioUnit` behind the `objc2-audio-toolbox` feature, a dependency change outside this unit,
/// so the selector is sent by hand.
// shortcut: `audioUnit` goes through the runtime instead of the typed binding, drop this when
// that feature is enabled.
fn audio_unit(node: &AVAudioInputNode) -> core_audio::AudioUnit {
    // SAFETY: `audioUnit` returns the node's own `AudioComponentInstance`, borrowed from the
    // node, which outlives this call.
    unsafe { msg_send![node, audioUnit] }
}

fn microphone_status(status: AVAuthorizationStatus) -> Authorization {
    match status {
        AVAuthorizationStatus::Authorized => Authorization::Authorized,
        AVAuthorizationStatus::Denied => Authorization::Denied,
        AVAuthorizationStatus::Restricted => Authorization::Restricted,
        _ => Authorization::NotDetermined,
    }
}

fn speech_status(status: SFSpeechRecognizerAuthorizationStatus) -> Authorization {
    match status {
        SFSpeechRecognizerAuthorizationStatus::Authorized => Authorization::Authorized,
        SFSpeechRecognizerAuthorizationStatus::Denied => Authorization::Denied,
        SFSpeechRecognizerAuthorizationStatus::Restricted => Authorization::Restricted,
        _ => Authorization::NotDetermined,
    }
}

fn describe(error: &NSError) -> String {
    error.localizedDescription().to_string()
}

/// The Mac's default input device.
pub struct MacMicrophone;

impl Microphone for MacMicrophone {
    fn authorization(&self) -> Authorization {
        // SAFETY: a framework constant, and audio is a media type this call accepts.
        match unsafe { AVMediaTypeAudio } {
            Some(audio) => microphone_status(unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) }),
            None => Authorization::Restricted,
        }
    }

    fn request_authorization(&self) -> Authorization {
        // SAFETY: as above.
        let Some(audio) = (unsafe { AVMediaTypeAudio }) else { return Authorization::Restricted };
        let (tx, rx) = mpsc::channel();
        let handler = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        // SAFETY: the handler matches the documented signature; it runs on an arbitrary queue.
        unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &handler) };
        match rx.recv() {
            Ok(true) => Authorization::Authorized,
            _ => self.authorization(),
        }
    }

    fn open(&self, device: Option<&str>, sink: Sink) -> Result<Box<dyn Stream>, VoiceError> {
        // The device the user chose is a preference, not a condition: when it is refused or
        // throws, the system default is opened and the note is recorded anyway (S3).
        let (started, refused) = match attempt(device, &sink) {
            Ok(started) => (started, None),
            Err(why) if device.is_some() => (attempt(None, &sink)?, Some(why)),
            Err(why) => return Err(why),
        };
        let Started { engine, tap, opened, rate, channels } = started;
        // Which device and which format were opened: the evidence S6 needs, not a guess. The
        // device is read back from the unit rather than assumed, so a refused choice shows the
        // device that was really used and the one that was asked for.
        let in_use = match (&opened, refused.is_some() || device.is_none()) {
            (Some(opened), true) => format!("the system default input \"{}\"", opened.name),
            (Some(opened), false) => format!("the microphone \"{}\"", opened.name),
            (None, true) => "the system default input".to_string(),
            (None, false) => opening(device),
        };
        let fallback = refused.as_ref().map_or_else(String::new, |why| format!(", after {why}"));
        eprintln!("gentle-dot: voice opened {in_use} at {rate} Hz, {channels} channels{fallback}");

        // A device change (headset unplugged, input switched) stops the engine; the engine also
        // posts this for its own reconfiguration while still running, which is not an
        // interruption (`configuration_change`, #10). The engine is read from the notification
        // rather than captured: Apple warns against releasing it inside this handler. Only a
        // real Mac exercises this path; a route change that stops the engine still ends the
        // recording (no transparent restart), naming the device that was in use (S5).
        let lost = opened.as_ref().map_or_else(
            || VoiceError::Interrupted.to_string(),
            |opened| format!("The microphone \"{}\" was disconnected.", opened.name),
        );
        let interrupted = RcBlock::new(move |note: NonNull<NSNotification>| {
            // SAFETY: the notification is valid for the call; its object is the observed engine.
            let note = unsafe { note.as_ref() };
            let engine = note.object();
            // SAFETY: reading a flag off the engine, on the thread that posted the notification.
            let running = engine
                .as_deref()
                .and_then(|object| object.downcast_ref::<AVAudioEngine>())
                .is_some_and(|engine| unsafe { engine.isRunning() });
            if super::configuration_change(running).is_some() {
                sink.failed(&lost);
            }
        });
        let engine_object: &AnyObject = &engine;
        // SAFETY: a framework constant name, observed for this engine only; the block posts
        // on the notifying thread and only calls the sink.
        let observer = unsafe {
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(AVAudioEngineConfigurationChangeNotification),
                Some(engine_object),
                None,
                &interrupted,
            )
        };
        Ok(Box::new(MacStream { engine, observer, _tap: tap, open: true }))
    }
}

/// A fresh engine with its input tap installed and running: one attempt at opening the
/// microphone, kept alive by the stream.
struct Started {
    engine: Retained<AVAudioEngine>,
    tap: RcBlock<dyn Fn(NonNull<AVAudioPCMBuffer>, NonNull<AVAudioTime>)>,
    /// The device the unit reports, read back rather than assumed (S6).
    opened: Option<core_audio::InputDevice>,
    rate: f64,
    channels: usize,
}

/// What an attempt opens, named the way the log and the errors name it.
fn opening(device: Option<&str>) -> String {
    device.map_or_else(|| "the system default input".to_string(), |uid| format!("the microphone \"{uid}\""))
}

/// One attempt at opening `device`, or the system default input when it is `None`.
fn attempt(device: Option<&str>, sink: &Sink) -> Result<Started, VoiceError> {
    // SAFETY: plain constructors and getters on a new engine.
    let engine = unsafe { AVAudioEngine::new() };
    // SAFETY: the engine's own input node.
    let input = unsafe { engine.inputNode() };
    // Choosing the device, reading the format that carries, and starting the engine all reach
    // CoreAudio through the input node's audio unit, and any of those can throw an Objective-C
    // exception; thrown across the FFI boundary it aborts the app (the crash report ends in
    // `__rust_panic_cleanup`), so the whole sequence is caught and comes back as a value.
    // shortcut: a caught exception skips the drops of the closure's own locals, so a refused
    // attempt leaks that engine; the system reclaims it at quit.
    let caught = objc2::exception::catch(AssertUnwindSafe(move || start(engine, input, device, sink)));
    match caught {
        Ok(started) => started,
        Err(exception) => {
            let reason = exception.map_or_else(|| "an unknown exception".to_string(), |exception| exception.to_string());
            Err(VoiceError::Failed(format!("The audio engine threw while opening {}: {reason}", opening(device))))
        }
    }
}

/// The device-dependent start: the device, the format it carries, the tap, and the engine. Runs
/// only inside `objc2::exception::catch`.
fn start(
    engine: Retained<AVAudioEngine>,
    input: Retained<AVAudioInputNode>,
    device: Option<&str>,
    sink: &Sink,
) -> Result<Started, VoiceError> {
    // The device belongs to the input node's audio unit, so it is chosen before `prepare()`; the
    // format read below is then the one that device carries.
    if let Some(uid) = device {
        core_audio::select_input(audio_unit(&input), uid).map_err(VoiceError::Failed)?;
    }
    // SAFETY: the node's own format for its output bus, borrowed for the call.
    let format = unsafe { input.outputFormatForBus(0) };
    // SAFETY: plain getters on the format.
    let (rate, channels) = unsafe { (format.sampleRate(), format.channelCount() as usize) };
    if rate <= 0.0 || channels == 0 {
        return Err(VoiceError::NoMicrophone);
    }
    let resampler = RefCell::new(Resampler::new(rate));
    let audio_sink = sink.clone();
    let tap = RcBlock::new(move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
        // SAFETY: the engine passes a valid buffer in the input node's format (deinterleaved
        // float32 with `channels` channels), valid for the duration of the call.
        let buffer = unsafe { buffer.as_ref() };
        let frames = unsafe { buffer.frameLength() } as usize;
        let data = unsafe { buffer.floatChannelData() };
        if data.is_null() || frames == 0 {
            return;
        }
        let planes: Vec<&[f32]> = (0..channels)
            // SAFETY: `data` holds one pointer per channel, each to `frames` samples.
            .map(|c| unsafe { std::slice::from_raw_parts((*data.add(c)).as_ptr(), frames) })
            .collect();
        let pcm = resampler.borrow_mut().process(&audio::mono(&planes));
        // The buffer itself goes along for Apple Speech, which appends it as captured.
        audio_sink.audio_native(&pcm, buffer as &NativeAudio);
    });
    let tap_block = &*tap as *const block2::DynBlock<_> as *mut block2::DynBlock<_>;
    // SAFETY: the block matches AVAudioNodeTapBlock and stays alive in the returned `Started`.
    unsafe { input.installTapOnBus_bufferSize_format_block(0, TAP_FRAMES, Some(&format), tap_block) };
    // SAFETY: the engine has its input connected through the tap.
    unsafe { engine.prepare() };
    if let Err(error) = unsafe { engine.startAndReturnError() } {
        // SAFETY: removing the tap this attempt installed, so a refused start leaves none behind.
        unsafe { input.removeTapOnBus(0) };
        return Err(VoiceError::Failed(format!("The microphone could not start: {}", describe(&error))));
    }
    // SAFETY: reading the property back off the unit the engine is running on.
    let opened = core_audio::opened_input(audio_unit(&input));
    Ok(Started { engine, tap, opened, rate, channels })
}

struct MacStream {
    engine: Retained<AVAudioEngine>,
    observer: Retained<ProtocolObject<dyn NSObjectProtocol>>,
    _tap: RcBlock<dyn Fn(NonNull<AVAudioPCMBuffer>, NonNull<AVAudioTime>)>,
    open: bool,
}

// SAFETY: AVAudioEngine and the observer token are not tied to a thread; the stream is only
// used behind the machine's locks, one thread at a time, and the tap block is only invoked by
// the engine.
unsafe impl Send for MacStream {}

impl Stream for MacStream {
    fn close(&mut self) {
        if !std::mem::take(&mut self.open) {
            return;
        }
        // SAFETY: stopping a live engine and removing what `open` installed.
        unsafe {
            NSNotificationCenter::defaultCenter().removeObserver(AsRef::<AnyObject>::as_ref(&*self.observer));
            self.engine.stop();
            self.engine.inputNode().removeTapOnBus(0);
        }
    }
}

impl Drop for MacStream {
    fn drop(&mut self) {
        self.close();
    }
}

/// Apple's Speech framework.
pub struct AppleSpeech;

impl Recognizer for AppleSpeech {
    fn authorization(&self) -> Authorization {
        // SAFETY: a class getter without side effects (it never prompts).
        speech_status(unsafe { SFSpeechRecognizer::authorizationStatus() })
    }

    fn request_authorization(&self) -> Authorization {
        let (tx, rx) = mpsc::channel();
        let handler = RcBlock::new(move |status: SFSpeechRecognizerAuthorizationStatus| {
            let _ = tx.send(status);
        });
        // SAFETY: the handler matches the documented signature; Info.plist carries
        // NSSpeechRecognitionUsageDescription (without it this call aborts the app).
        unsafe { SFSpeechRecognizer::requestAuthorization(&handler) };
        rx.recv().map(speech_status).unwrap_or_else(|_| self.authorization())
    }

    fn current_locale(&self) -> String {
        NSLocale::currentLocale().localeIdentifier().to_string()
    }

    fn supported_locales(&self) -> Vec<String> {
        // SAFETY: a class getter returning a set of locales.
        let locales = unsafe { SFSpeechRecognizer::supportedLocales() };
        locales.allObjects().iter().map(|locale| locale.localeIdentifier().to_string()).collect()
    }

    fn begin(&self, locale: &str, sink: Sink) -> Result<Box<dyn Recognition>, VoiceError> {
        let ns_locale = NSLocale::initWithLocaleIdentifier(NSLocale::alloc(), &NSString::from_str(locale));
        let handler = RcBlock::new(move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
            // SAFETY: Speech passes a valid result or error (or null), valid for the call.
            if let Some(result) = unsafe { result.as_ref() } {
                let text = unsafe { result.bestTranscription().formattedString() }.to_string();
                if unsafe { result.isFinal() } {
                    sink.finished(&text);
                } else {
                    sink.partial(&text);
                }
            } else if let Some(error) = unsafe { error.as_ref() } {
                sink.failed(&describe(error));
            }
        });
        // SAFETY: plain initializers, setters, and getters on objects created here.
        unsafe {
            let recognizer = SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &ns_locale)
                .ok_or_else(|| VoiceError::NoRecognizer(locale.to_string()))?;
            if !recognizer.isAvailable() {
                return Err(VoiceError::Failed(
                    "Speech recognition is not available right now. Check the internet connection and try again.".into(),
                ));
            }
            // Results default to the main queue; keep them off it.
            recognizer.setQueue(&NSOperationQueue::new());
            let request = SFSpeechAudioBufferRecognitionRequest::new();
            request.setShouldReportPartialResults(true);
            if recognizer.supportsOnDeviceRecognition() {
                request.setRequiresOnDeviceRecognition(true);
            }
            if available!(macos = 13.0) {
                request.setAddsPunctuation(true);
            }
            let format = AVAudioFormat::initStandardFormatWithSampleRate_channels(
                AVAudioFormat::alloc(),
                f64::from(SAMPLE_RATE),
                1,
            )
            .ok_or_else(|| VoiceError::Failed("The audio format is not supported.".into()))?;
            let task = recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler);
            Ok(Box::new(AppleRecognition { _recognizer: recognizer, request, task, format }))
        }
    }
}

struct AppleRecognition {
    /// Kept alive until the final result arrives.
    _recognizer: Retained<SFSpeechRecognizer>,
    request: Retained<SFSpeechAudioBufferRecognitionRequest>,
    task: Retained<SFSpeechRecognitionTask>,
    /// 16 kHz mono float32, deinterleaved.
    format: Retained<AVAudioFormat>,
}

// SAFETY: the request is meant to be fed from the audio thread and ended or cancelled from
// another; the machine serializes every call behind a lock.
unsafe impl Send for AppleRecognition {}

impl Recognition for AppleRecognition {
    fn feed(&mut self, samples: &[f32]) {
        let Ok(frames) = u32::try_from(samples.len()) else { return };
        // SAFETY: a new buffer in our mono format with room for `frames`; its single channel
        // receives exactly `frames` samples before the request copies it.
        unsafe {
            let Some(buffer) = AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(AVAudioPCMBuffer::alloc(), &self.format, frames)
            else {
                return;
            };
            buffer.setFrameLength(frames);
            let data = buffer.floatChannelData();
            if data.is_null() {
                return;
            }
            std::ptr::copy_nonoverlapping(samples.as_ptr(), (*data).as_ptr(), samples.len());
            self.request.appendAudioPCMBuffer(&buffer);
        }
    }

    fn wants_native(&self) -> bool {
        true
    }

    /// The input node's tap buffer, in its own rate and channel layout. The request retains
    /// what it needs, as with Apple's `request.append(buffer)` in the tap.
    fn feed_native(&mut self, audio: &NativeAudio) {
        if let Some(buffer) = audio.downcast_ref::<AVAudioPCMBuffer>() {
            // SAFETY: a valid buffer from the engine's tap, used within the tap call.
            unsafe { self.request.appendAudioPCMBuffer(buffer) };
        }
    }

    fn finish(&mut self) {
        // SAFETY: ending the audio of a live request; the final result follows on the queue.
        unsafe { self.request.endAudio() };
    }

    fn cancel(&mut self) {
        // SAFETY: cancelling a live task; its late "cancelled" error is ignored by the sink.
        unsafe { self.task.cancel() };
    }
}
