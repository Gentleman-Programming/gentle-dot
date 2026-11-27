// Harmless native bridge fixture; never reads the script or record.
fn main() {
    use std::{env, path::PathBuf};
    let root = PathBuf::from(env::var_os("GENTLE_DOT_RUNTIME").unwrap());
    let data = PathBuf::from(env::var_os("GENTLE_DOT_DATA_DIR").unwrap());
    let mut args = env::args_os().skip(1);
    assert_eq!(PathBuf::from(args.next().unwrap()), root.join(r"daemon\cli.mjs"));
    assert!(args.next().is_none());
    assert_eq!(env::current_dir().unwrap(), data);
    assert_eq!(env::var("GENTLE_DOT_PORT").unwrap(), "4317");
    assert_eq!(env::var("PATH").unwrap(), format!(r"{0}\bin;{0}\node", root.display()));
    assert!(env::var_os("SHERPA_ONNX_LIB_DIR").is_none());
}
