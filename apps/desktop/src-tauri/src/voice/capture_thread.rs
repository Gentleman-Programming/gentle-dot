//! A capture that runs on a thread of its own and polls the device for packets: starting it
//! with a bounded wait, delivering until a close, and closing it. Nothing here touches a device,
//! so it is compiled on every platform and its tests run on all of them; the Windows
//! microphone (`wasapi`) is what uses it.

use super::{Stream, VoiceError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::Duration;

/// Where the capture thread says whether the device started.
pub(crate) type Ready = mpsc::Sender<Result<(), VoiceError>>;

pub(crate) fn failed_to_start(error: impl std::fmt::Display) -> VoiceError {
    VoiceError::Failed(format!("The microphone could not start: {error}"))
}

/// Runs `run` on the capture thread and waits up to `wait` for it to say whether the device
/// started. The device can block inside activation or start indefinitely (Windows does), so a
/// timeout does not wait for the thread: it closes the stream and stops listening, and the
/// thread, once the device returns, finds nobody waiting, stops the device, and ends without
/// capturing.
pub(crate) fn launch(
    run: impl FnOnce(Arc<AtomicBool>, Ready) + Send + 'static,
    wait: Duration,
) -> Result<CaptureStream, VoiceError> {
    let closed = Arc::new(AtomicBool::new(false));
    let (ready, started) = mpsc::channel();
    let flag = closed.clone();
    let thread = std::thread::Builder::new()
        .name("voice-capture".into())
        .spawn(move || run(flag, ready))
        .map_err(failed_to_start)?;
    let mut stream = CaptureStream { closed, thread: Some(thread) };
    match started.recv_timeout(wait) {
        Ok(Ok(())) => Ok(stream),
        Ok(Err(error)) => {
            stream.close();
            Err(error)
        }
        Err(_) => {
            stream.closed.store(true, Ordering::SeqCst);
            drop(stream.thread.take());
            drop(started);
            Err(failed_to_start("the audio device did not answer"))
        }
    }
}

/// Delivers waiting packets, then sleeps a poll, until the stream is closed. The flag is checked
/// before every packet, so a device that always has another one ready cannot keep the capture
/// going after a close.
pub(crate) fn pump<E>(
    mut waiting: impl FnMut() -> Result<u32, E>,
    mut read: impl FnMut() -> Result<Vec<f32>, E>,
    closed: &AtomicBool,
    mut deliver: impl FnMut(&[f32]),
    poll: Duration,
) -> Result<(), E> {
    while !closed.load(Ordering::SeqCst) {
        while !closed.load(Ordering::SeqCst) && waiting()? > 0 {
            let samples = read()?;
            if !samples.is_empty() {
                deliver(&samples);
            }
        }
        std::thread::sleep(poll);
    }
    Ok(())
}

/// The open capture: closing it raises the flag the thread polls and waits for the thread.
pub(crate) struct CaptureStream {
    closed: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Stream for CaptureStream {
    fn close(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            // A failure reported from the capture thread closes the stream on that same thread
            // (the machine discards the recording there); it is already on its way out.
            if thread.thread().id() != std::thread::current().id() {
                let _ = thread.join();
            }
        }
    }
}

impl Drop for CaptureStream {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn a_close_ends_capture_even_while_packets_keep_arriving() {
        let closed = Arc::new(AtomicBool::new(false));
        let delivered = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (done, finished) = mpsc::channel();
        let (flag, count) = (closed.clone(), delivered.clone());
        std::thread::spawn(move || {
            // Another packet is always ready, as when delivery keeps up with the device only just.
            let result = pump(
                || Ok::<u32, ()>(1),
                || Ok(vec![0.25; 160]),
                &flag,
                |_| {
                    count.fetch_add(1, Ordering::SeqCst);
                },
                Duration::from_millis(1),
            );
            let _ = done.send(result);
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while delivered.load(Ordering::SeqCst) < 10 {
            assert!(Instant::now() < deadline, "packets flow");
            std::thread::yield_now();
        }
        closed.store(true, Ordering::SeqCst);
        assert_eq!(finished.recv_timeout(Duration::from_secs(2)), Ok(Ok(())), "the close ends the capture");
        let after = delivered.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(delivered.load(Ordering::SeqCst), after, "nothing is delivered once the capture ended");
    }

    #[test]
    fn a_device_that_never_answers_times_out_without_waiting_for_the_device() {
        let (outcome, observed) = mpsc::channel();
        let started = Instant::now();
        let result = launch(
            move |closed, ready| {
                // The device is still activating when the wait runs out.
                std::thread::sleep(Duration::from_millis(600));
                let nobody_waiting = ready.send(Ok(())).is_err();
                let _ = outcome.send((nobody_waiting, closed.load(Ordering::SeqCst)));
            },
            Duration::from_millis(50),
        );
        assert!(started.elapsed() < Duration::from_millis(400), "the timeout does not wait for the device");
        assert_eq!(
            result.err(),
            Some(VoiceError::Failed("The microphone could not start: the audio device did not answer".into()))
        );
        assert_eq!(
            observed.recv_timeout(Duration::from_secs(3)),
            Ok((true, true)),
            "the late thread finds nobody waiting and the stream closed, so it stops the device without capturing"
        );
    }

    #[test]
    fn a_start_failure_is_returned_once_the_thread_ended() {
        let ended = Arc::new(AtomicBool::new(false));
        let flag = ended.clone();
        let result = launch(
            move |_, ready| {
                let _ = ready.send(Err(VoiceError::NoMicrophone));
                std::thread::sleep(Duration::from_millis(50));
                flag.store(true, Ordering::SeqCst);
            },
            Duration::from_secs(2),
        );
        assert_eq!(result.err(), Some(VoiceError::NoMicrophone));
        assert!(ended.load(Ordering::SeqCst), "open waits for the failed capture thread to end");
    }

    #[test]
    fn closing_or_dropping_waits_for_the_capture_thread_and_closing_twice_is_harmless() {
        for drop_it in [false, true] {
            let ended = Arc::new(AtomicBool::new(false));
            let flag = ended.clone();
            let mut stream = launch(
                move |closed, ready| {
                    let _ = ready.send(Ok(()));
                    while !closed.load(Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    std::thread::sleep(Duration::from_millis(30));
                    flag.store(true, Ordering::SeqCst);
                },
                Duration::from_secs(2),
            )
            .unwrap();
            if drop_it {
                drop(stream);
            } else {
                stream.close();
                stream.close();
            }
            assert!(ended.load(Ordering::SeqCst), "drop={drop_it}: the thread ended before close returned");
        }
    }

    /// A device failure while recording reports `Sink::failed` on the capture thread, and the
    /// machine discards the recording there, closing the stream from inside the thread it joins.
    #[test]
    fn a_close_from_the_capture_thread_itself_ends_it_without_blocking() {
        let (hand_over, stream_arrives) = mpsc::channel::<CaptureStream>();
        let (closed_itself, observed) = mpsc::channel();
        let stream = launch(
            move |closed, ready| {
                let _ = ready.send(Ok(()));
                let Ok(mut stream) = stream_arrives.recv() else { return };
                stream.close();
                let _ = closed_itself.send(closed.load(Ordering::SeqCst));
                drop(stream);
                let _ = closed_itself.send(true);
            },
            Duration::from_secs(2),
        )
        .unwrap();
        hand_over.send(stream).unwrap();
        // Bounded, so a self-join fails the test instead of hanging the suite.
        let wait = Duration::from_secs(2);
        assert_eq!(observed.recv_timeout(wait), Ok(true), "close returned on the capture thread with the flag raised");
        assert_eq!(observed.recv_timeout(wait), Ok(true), "dropping the closed stream there is harmless too");
        assert_eq!(
            observed.recv_timeout(wait),
            Err(mpsc::RecvTimeoutError::Disconnected),
            "the capture thread ended"
        );
    }
}
