//! Classic desktop SAPI synthesis only: no endpoint playback, files, or WinRT.
//! Parent registers this Windows-only module; the WAV codec is private to it.
#[path = "speech_wave.rs"]
mod speech_wave;

use speech_wave::{check_live, check_request, language_rank, Pcm};
use std::sync::{atomic::AtomicBool, Arc};
use std::time::Instant;
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

/// Blocking API for a background command adapter. Only owned text, locale, cancel
/// flag and bytes/errors cross this fresh thread; COM never leaves its apartment.
pub fn synthesize_wav(text: &str, locale: &str, cancelled: Arc<AtomicBool>) -> Result<Vec<u8>, String> {
    check_request(text, locale)?;
    check_live(&cancelled, std::time::Duration::ZERO, 0)?;
    let (text, locale) = (text.to_owned(), locale.to_owned());
    let worker_cancel = cancelled.clone();
    let result = std::thread::Builder::new().name("windows-speech".into()).spawn(move || {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok() }
            .map_err(|e| failure("COM initialization", e))?;
        let _com = ComApartment(std::marker::PhantomData);
        // This call's locals (including all interfaces/task allocations) unwind
        // before the apartment guard, on this same thread, on every return path.
        synthesize_owned(&text, &locale, &worker_cancel)
    }).map_err(|_| "Could not start speech worker".to_string())?
        .join().map_err(|_| "Speech worker panicked".to_string())?;
    check_live(&cancelled, std::time::Duration::ZERO, 0)?;
    result
}

struct ComApartment(std::marker::PhantomData<std::rc::Rc<()>>);
impl Drop for ComApartment {
    fn drop(&mut self) { unsafe { CoUninitialize() }; }
}

// This wrapper deliberately stays worker-local, like every COM interface.
struct TaskAllocation(*mut std::ffi::c_void);
impl Drop for TaskAllocation {
    fn drop(&mut self) { unsafe { CoTaskMemFree(Some(self.0)) }; }
}

fn failure(stage: &str, error: Error) -> String {
    // No text, locale attributes, device identifiers or engine messages in errors.
    format!("Windows speech {stage} failed (HRESULT {:08X})", error.code().0 as u32)
}

fn synthesize_owned(text: &str, locale: &str, cancelled: &AtomicBool) -> Result<Vec<u8>, String> {
    let started = Instant::now();
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
    // No Speak occurs before redirection. Never permit automatic format changes.
    unsafe { voice.SetOutput(&stream, false) }.map_err(|e| failure("memory output setup", e))?;
    let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    let mut utterance = Utterance { voice: &voice, active: true };
    let result = (|| {
        check_live(cancelled, started.elapsed(), 0)?;
        let mut number = 0;
        unsafe { voice.Speak(PCWSTR(wide.as_ptr()), (SPF_ASYNC.0 | SPF_IS_NOT_XML.0) as u32, Some(&mut number)) }
            .map_err(|e| failure("Speak", e))?;
        loop {
            check_live(cancelled, started.elapsed(), stream_size(&memory)?)?;
            // S_FALSE is erased by this projection. Ok is NOT completion proof.
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
    let mut samples = vec![0; length as usize];
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
        // Empty plain text with PURGEBEFORESPEAK cancels the outstanding async job.
        // Attempt once; if it fails, report it and release the worker-owned voice.
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
    // windows 0.62.2 metadata projects this output GUID as *const. Derive
    // a raw pointer from UNIQUE mutable storage, never from an immutable borrow.
    // GetFormat writes into initialized GUID storage; no invented SPDFID value.
    let id_pointer = std::ptr::addr_of_mut!(id).cast_const();
    let allocated = unsafe { output.GetFormat(id_pointer) }.map_err(|e| failure("output format", e))?;
    let _allocation = TaskAllocation(allocated.cast());
    if allocated.is_null() { return Err("Speech output format is missing".into()); }
    let format = unsafe { allocated.read_unaligned() };
    // Explicitly support ordinary integer PCM only. Compressed, extensible,
    // float, and extra format payloads require a decoder we do not provide.
    if id == GUID::default() || format.wFormatTag != 1 || format.cbSize != 0 {
        return Err("Unsupported speech output format; ordinary PCM required".into());
    }
    let pcm = Pcm { channels: format.nChannels, rate: format.nSamplesPerSec,
        bits: format.wBitsPerSample, align: format.nBlockAlign, byte_rate: format.nAvgBytesPerSec }.validate()?;
    Ok((id, format, pcm))
}

fn select_locale(voice: &ISpVoice, locale: &str, cancelled: &AtomicBool, started: Instant) -> Result<(), String> {
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
        // Native string contract guarantees termination; bound our scan/copy.
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
    // No matching installed voice: retain this new SpVoice's system default.
    // Enumeration/conversion errors above are not disguised as fallback success.
    if let Some(token) = best {
        unsafe { voice.SetVoice(&token) }.map_err(|e| failure("locale voice selection", e))?;
    }
    Ok(())
}
