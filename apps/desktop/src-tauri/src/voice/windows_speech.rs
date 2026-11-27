//! Classic desktop SAPI synthesis only: memory WAV, no endpoint playback, files, or WinRT.
use super::speech_wave::{check_live, check_request, language_rank, Pcm};
use std::sync::{atomic::AtomicBool, Arc};
use std::time::{Duration, Instant};
use ::windows::core::{w, Error, GUID, PCWSTR, PWSTR};
use ::windows::Win32::Foundation::HGLOBAL;
use ::windows::Win32::Globalization::{LocaleNameToLCID, LOCALE_ALLOW_NEUTRAL_NAMES};
use ::windows::Win32::Media::Audio::WAVEFORMATEX;
use ::windows::Win32::Media::Speech::{
    ISpObjectTokenCategory, ISpStream, ISpVoice, SpObjectTokenCategory, SpStream, SpVoice,
    SPCAT_VOICES, SPF_ASYNC, SPF_IS_NOT_XML, SPF_PURGEBEFORESPEAK, SPRS_DONE, SPVOICESTATUS,
};
use ::windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IStream,
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET,
};
use ::windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;

/// Blocking API for a later background adapter. Only owned text, locale, cancel
/// flag and bytes/errors cross the worker boundary; COM stays in its apartment.
#[allow(dead_code)]
pub fn synthesize_wav(text: &str, locale: &str, cancelled: Arc<AtomicBool>) -> Result<Vec<u8>, String> {
    check_request(text, locale)?;
    check_live(&cancelled, Duration::ZERO, 0)?;
    let started = Instant::now();
    let (text, locale) = (text.to_owned(), locale.to_owned());
    let worker_cancel = cancelled.clone();
    let result = std::thread::Builder::new().name("windows-speech".into()).spawn(move || {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok() }
            .map_err(|e| failure("COM initialization", e))?;
        let _com = ComApartment(std::marker::PhantomData);
        // All interfaces and task allocations unwind inside synthesize_owned,
        // before this guard calls CoUninitialize on the same worker thread.
        synthesize_owned(&text, &locale, &worker_cancel, started)
    }).map_err(|_| "Could not start speech worker".to_string())?
        .join().map_err(|_| "Speech worker panicked".to_string())?;
    let wav = result?; // Preserve synthesis/purge failures rather than masking them.
    check_live(&cancelled, started.elapsed(), 0)?;
    Ok(wav)
}

struct ComApartment(std::marker::PhantomData<std::rc::Rc<()>>);
impl Drop for ComApartment {
    fn drop(&mut self) { unsafe { CoUninitialize() }; }
}

// Worker-local, like every COM interface; includes format and token strings.
struct TaskAllocation(*mut std::ffi::c_void);
impl Drop for TaskAllocation {
    fn drop(&mut self) { unsafe { CoTaskMemFree(Some(self.0)) }; }
}

fn failure(stage: &str, error: Error) -> String {
    // No text, identifiers, attributes, or engine-provided messages in errors.
    format!("Windows speech {stage} failed (HRESULT {:08X})", error.code().0 as u32)
}

fn synthesize_owned(text: &str, locale: &str, cancelled: &AtomicBool, started: Instant) -> Result<Vec<u8>, String> {
    check_live(cancelled, started.elapsed(), 0)?;
    let voice: ISpVoice = unsafe { CoCreateInstance(&SpVoice, None, CLSCTX_INPROC_SERVER) }
        .map_err(|e| failure("voice creation", e))?;
    select_locale(&voice, locale, cancelled, started)?;
    let (format_id, format, pcm) = output_format(&voice)?;
    check_live(cancelled, started.elapsed(), 0)?;
    let memory = unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true) }
        .map_err(|e| failure("memory stream creation", e))?;
    let stream: ISpStream = unsafe { CoCreateInstance(&SpStream, None, CLSCTX_INPROC_SERVER) }
        .map_err(|e| failure("speech stream creation", e))?;
    unsafe { stream.SetBaseStream(&memory, &format_id, &format) }
        .map_err(|e| failure("memory format setup", e))?;
    // No Speak before successful redirection. No automatic format changes and
    // no fallback to the voice's default speaker if either output call fails.
    unsafe { voice.SetOutput(&stream, false) }.map_err(|e| failure("memory output setup", e))?;
    let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    let mut utterance = Utterance { voice: &voice, active: true };
    let result = (|| {
        check_live(cancelled, started.elapsed(), 0)?;
        let mut number = 0;
        // Plain literal text: neither XML nor filename/audio URL interpretation.
        unsafe { voice.Speak(PCWSTR(wide.as_ptr()), (SPF_ASYNC.0 | SPF_IS_NOT_XML.0) as u32, Some(&mut number)) }
            .map_err(|e| failure("Speak", e))?;
        loop {
            // Cooperative monitoring, NOT a hard cap on IStream's internal
            // allocator between polls or while a native COM call is blocked.
            check_live(cancelled, started.elapsed(), stream_size(&memory)?)?;
            // S_FALSE is erased by this projection; Ok alone is not completion.
            unsafe { voice.WaitUntilDone(25) }.map_err(|e| failure("speech wait", e))?;
            let mut status = SPVOICESTATUS::default();
            let mut bookmark = PWSTR::null();
            let status_result = unsafe { voice.GetStatus(&mut status, &mut bookmark) };
            let _bookmark = TaskAllocation(bookmark.0.cast());
            status_result.map_err(|e| failure("speech status", e))?;
            status.hrLastResult.ok().map_err(|e| failure("synthesis engine", e))?;
            if status.dwRunningState == SPRS_DONE.0 as u32 && status.ulLastStreamQueued == number {
                break;
            }
        }
        check_live(cancelled, started.elapsed(), stream_size(&memory)?)?;
        Ok(())
    })();
    if let Err(error) = result {
        return match utterance.purge() {
            Ok(()) => Err(error),
            Err(purge_error) => Err(format!("{error}; {purge_error}")),
        };
    }
    utterance.active = false; // GetStatus proved this utterance has retired.
    let length = stream_size(&memory)?;
    check_live(cancelled, started.elapsed(), length)?;
    if length == 0 { return Err("Speech engine produced no audio".into()); }
    let mut samples = vec![0; length as usize]; // length was checked against 16 MiB.
    unsafe { memory.Seek(0, STREAM_SEEK_SET, None) }.map_err(|e| failure("memory seek", e))?;
    let mut read = 0;
    unsafe { memory.Read(samples.as_mut_ptr().cast(), samples.len() as u32, Some(&mut read)).ok() }
        .map_err(|e| failure("memory read", e))?;
    if read as usize != samples.len() { return Err("Truncated speech memory stream".into()); }
    check_live(cancelled, started.elapsed(), length)?;
    let wav = pcm.wav(&samples)?;
    check_live(cancelled, started.elapsed(), length)?;
    Ok(wav)
}

struct Utterance<'a> { voice: &'a ISpVoice, active: bool }
impl Utterance<'_> {
    fn purge(&mut self) -> Result<(), String> {
        // Empty plain text purges the async job. Attempt once, then release the
        // worker-owned voice even on failure; never silently claim retirement.
        self.active = false;
        unsafe { self.voice.Speak(w!(""), (SPF_PURGEBEFORESPEAK.0 | SPF_IS_NOT_XML.0) as u32, None) }
            .map_err(|e| failure("cancellation purge", e))
    }
}
impl Drop for Utterance<'_> {
    fn drop(&mut self) {
        if self.active { let _ = self.purge(); }
    }
}

fn stream_size(stream: &IStream) -> Result<u64, String> {
    let mut stat = STATSTG::default();
    unsafe { stream.Stat(&mut stat, STATFLAG_NONAME) }.map_err(|e| failure("memory size", e))?;
    Ok(stat.cbSize)
}

fn output_format(voice: &ISpVoice) -> Result<(GUID, WAVEFORMATEX, Pcm), String> {
    let output = unsafe { voice.GetOutputStream() }.map_err(|e| failure("output format stream", e))?;
    let mut id = GUID::default();
    // windows 0.62.2 projects this output GUID as *const. Derive the pointer
    // from UNIQUE mutable storage, never from an immutable borrow.
    let id_pointer = std::ptr::addr_of_mut!(id).cast_const();
    let allocated = unsafe { output.GetFormat(id_pointer) }.map_err(|e| failure("output format", e))?;
    let _allocation = TaskAllocation(allocated.cast());
    if allocated.is_null() { return Err("Speech output format is missing".into()); }
    let format = unsafe { allocated.read_unaligned() };
    // No compressed, extensible, float, or extra format payloads: no decoder.
    if id == GUID::default() || format.wFormatTag != 1 || format.cbSize != 0 {
        return Err("Unsupported speech output format; ordinary PCM required".into());
    }
    let pcm = Pcm { channels: format.nChannels, rate: format.nSamplesPerSec,
        bits: format.wBitsPerSample, align: format.nBlockAlign, byte_rate: format.nAvgBytesPerSec }.validate()?;
    Ok((id, format, pcm))
}

fn select_locale(voice: &ISpVoice, locale: &str, cancelled: &AtomicBool, started: Instant) -> Result<(), String> {
    check_live(cancelled, started.elapsed(), 0)?;
    let wide: Vec<u16> = locale.encode_utf16().chain(Some(0)).collect();
    let lcid = unsafe { LocaleNameToLCID(PCWSTR(wide.as_ptr()), LOCALE_ALLOW_NEUTRAL_NAMES) };
    if lcid == 0 { return Err("Unsupported or invalid speech locale".into()); }
    let category: ISpObjectTokenCategory = unsafe { CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_INPROC_SERVER) }
        .map_err(|e| failure("voice catalog creation", e))?;
    unsafe { category.SetId(SPCAT_VOICES, false) }.map_err(|e| failure("voice catalog", e))?;
    let tokens = unsafe { category.EnumTokens(PCWSTR::null(), PCWSTR::null()) }
        .map_err(|e| failure("voice enumeration", e))?;
    let mut count = 0;
    unsafe { tokens.GetCount(&mut count) }.map_err(|e| failure("voice count", e))?;
    if count > 256 { return Err("Speech voice catalog exceeds limit".into()); }
    let mut best = None;
    let mut best_rank = 0;
    for index in 0..count {
        check_live(cancelled, started.elapsed(), 0)?;
        let token = unsafe { tokens.Item(index) }.map_err(|e| failure("voice token", e))?;
        let attributes = unsafe { token.OpenKey(w!("Attributes")) }.map_err(|e| failure("voice attributes", e))?;
        let language = unsafe { attributes.GetStringValue(w!("Language")) }.map_err(|e| failure("voice language", e))?;
        let _language = TaskAllocation(language.0.cast());
        if language.is_null() { return Err("Speech voice language is missing".into()); }
        let mut units = Vec::new();
        // The native string contract guarantees NUL termination. Bound our copy.
        for offset in 0..512 {
            let unit = unsafe { *language.0.add(offset) };
            if unit == 0 { break; }
            units.push(unit);
        }
        if units.len() == 512 { return Err("Speech voice language exceeds limit".into()); }
        let languages = String::from_utf16(&units).map_err(|_| "Invalid speech voice language encoding".to_string())?;
        let rank = language_rank(&languages, lcid as u16);
        if rank > best_rank { best = Some(token); best_rank = rank; }
        if rank == 2 { break; }
    }
    check_live(cancelled, started.elapsed(), 0)?;
    // No language match retains this fresh SpVoice's default *voice*, not its
    // default output. Enumeration/conversion errors are never fallback success.
    if let Some(token) = best {
        unsafe { voice.SetVoice(&token) }.map_err(|e| failure("voice selection", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::speech_wave::{Pcm, MAX_AUDIO_BYTES};

    #[test]
    fn rejects_invalid_requests_before_com_or_device_work() {
        for (text, locale) in [("", "en-US"), ("hello\0world", "en-US"), ("hello", "")] {
            let result = synthesize_wav(text, locale, Arc::new(AtomicBool::new(false)));
            let expected = if locale.is_empty() {
                "Invalid speech locale"
            } else {
                "Speech text is empty, contains NUL, or exceeds 4000 UTF-16 units"
            };
            assert_eq!(result, Err(expected.into()));
        }
    }

    #[test]
    fn pre_cancelled_request_returns_cancelled_before_com_or_device_work() {
        let result = synthesize_wav("A short synthesis test.", "en-US", Arc::new(AtomicBool::new(true)));
        assert_eq!(result, Err("Speech synthesis cancelled".into()));
    }

    #[test]
    #[ignore = "Windows SAPI integration: requires installed speech voices; renders to memory only"]
    fn renders_short_text_to_memory_wav() {
        let result = synthesize_wav("A short synthesis test.", "en-US", Arc::new(AtomicBool::new(false)));
        assert!(result.is_ok(), "memory-only synthesis must succeed: {result:?}");
        let wav = result.unwrap();
        assert!(wav.len() >= 46 && wav.len() <= MAX_AUDIO_BYTES + 45);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize, wav.len() - 8);
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(&wav[16..22], &[16, 0, 0, 0, 1, 0]);
        let pcm = Pcm {
            channels: u16::from_le_bytes(wav[22..24].try_into().unwrap()),
            rate: u32::from_le_bytes(wav[24..28].try_into().unwrap()),
            byte_rate: u32::from_le_bytes(wav[28..32].try_into().unwrap()),
            align: u16::from_le_bytes(wav[32..34].try_into().unwrap()),
            bits: u16::from_le_bytes(wav[34..36].try_into().unwrap()),
        };
        assert!(pcm.validate().is_ok(), "SAPI must return supported, consistent PCM");
        assert_eq!(&wav[36..40], b"data");
        let data_len = u32::from_le_bytes(wav[40..44].try_into().unwrap()) as usize;
        assert!(data_len > 0 && data_len <= MAX_AUDIO_BYTES);
        assert_eq!(data_len % usize::from(pcm.align), 0);
        assert_eq!(wav.len(), 44 + data_len + (data_len & 1));
        if data_len & 1 != 0 {
            assert_eq!(wav.last(), Some(&0));
        }
    }
}
