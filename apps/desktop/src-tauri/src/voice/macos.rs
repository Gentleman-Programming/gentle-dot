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
use super::{Authorization, Microphone, NativeAudio, Recognition, Recognizer, Sink, Stream, VoiceError};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{available, AnyThread};
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
use objc2_avf_audio::{
    AVAudioEngine, AVAudioEngineConfigurationChangeNotification, AVAudioFormat, AVAudioPCMBuffer, AVAudioTime,
};
use objc2_foundation::{NSError, NSLocale, NSNotification, NSNotificationCenter, NSObjectProtocol, NSOperationQueue, NSString};
use objc2_speech::{
    SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask, SFSpeechRecognizer,
    SFSpeechRecognizerAuthorizationStatus,
};
use std::cell::RefCell;
use std::ptr::NonNull;
use std::sync::mpsc;

/// Frames per tap callback at the device rate (about 21 ms at 48 kHz).
const TAP_FRAMES: u32 = 1_024;

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

    fn open(&self, sink: Sink) -> Result<Box<dyn Stream>, VoiceError> {
        // SAFETY: plain constructors and getters on a new engine.
        let engine = unsafe { AVAudioEngine::new() };
        let input = unsafe { engine.inputNode() };
        let format = unsafe { input.outputFormatForBus(0) };
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
        // SAFETY: the block matches AVAudioNodeTapBlock and stays alive in the stream.
        unsafe { input.installTapOnBus_bufferSize_format_block(0, TAP_FRAMES, Some(&format), tap_block) };
        // SAFETY: the engine has its input connected through the tap.
        unsafe { engine.prepare() };
        if let Err(error) = unsafe { engine.startAndReturnError() } {
            unsafe { input.removeTapOnBus(0) };
            return Err(VoiceError::Failed(format!("The microphone could not start: {}", describe(&error))));
        }

        // A device change (headset unplugged, input switched) stops the engine.
        let interrupted = RcBlock::new(move |_note: NonNull<NSNotification>| {
            sink.failed(&VoiceError::Interrupted.to_string());
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
