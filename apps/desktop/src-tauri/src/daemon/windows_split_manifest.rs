//! Standalone admission of pinned inventory bytes and verification of an already-open reader.

use serde::de::{value::MapAccessDeserializer, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::io::{self, Read};
use std::marker::PhantomData;

const MAX_MANIFEST: usize = 16 * 1024 * 1024;
const MAX_SAFE_SIZE: u64 = (1 << 53) - 1;
// Keep in sync with scripts/windows/split-runtime-files.mjs (REQUIRED).
const REQUIRED: [&str; 7] = [
    "node/node.exe",
    "bin/engram.exe",
    "bin/pi.exe",
    "bin/private-storage.exe",
    "daemon/cli.mjs",
    "daemon/node_modules/gentle-pi/bin/gentle-shell.mjs",
    "ui/index.html",
];

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ManifestError {
    TooLarge,
    ManifestDigest,
    Schema,
    Tuple,
    Record,
    Path,
    Collision,
    MissingRequired,
    Read,
    FileSize,
    FileDigest,
}

pub(super) struct Manifest(Vec<FileRecord>);

pub(super) struct FileRecord {
    path: String,
    size: u64,
    digest: [u8; 32],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireManifest {
    schema: u64,
    target: String,
    shell: String,
    pi: String,
    files: Vec<Object<WireFile>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireFile {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    size: u64,
    sha256: String,
}

// Derive rejects duplicate and unknown fields but also accepts positional structs.
// Force JSON objects at both levels before invoking the typed field checks.
struct Object<T>(T);
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Object<T> {
    fn deserialize<D: Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        struct ObjectVisitor<T>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for ObjectVisitor<T> {
            type Value = Object<T>;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JSON object")
            }

            fn visit_map<M: MapAccess<'de>>(self, map: M) -> Result<Self::Value, M::Error> {
                T::deserialize(MapAccessDeserializer::new(map)).map(Object)
            }
        }
        de.deserialize_map(ObjectVisitor(PhantomData))
    }
}

impl Manifest {
    /// `expected` comes from the trusted build, not from the inventory's source.
    pub(super) fn decode(raw: &[u8], expected: [u8; 32]) -> Result<Self, ManifestError> {
        use ManifestError::*;
        if raw.len() > MAX_MANIFEST {
            return Err(TooLarge);
        }
        if <[u8; 32]>::from(Sha256::digest(raw)) != expected {
            return Err(ManifestDigest);
        }
        let Object(wire) = serde_json::from_slice::<Object<WireManifest>>(raw).map_err(|_| Schema)?;
        if (wire.schema, wire.target.as_str(), wire.shell.as_str(), wire.pi.as_str())
            != (1, "windows-x64", "5.0.0", "1.6.0")
        {
            return Err(Tuple);
        }
        let mut files = Vec::with_capacity(wire.files.len());
        for Object(file) in wire.files {
            if file.kind != "file" || file.size > MAX_SAFE_SIZE {
                return Err(Record);
            }
            let digest = parse_digest(&file.sha256).ok_or(Record)?;
            if file.path.len() > 240 || !file.path.split('/').all(safe_component) {
                return Err(Path);
            }
            files.push(FileRecord {
                path: file.path,
                size: file.size,
                digest,
            });
        }
        // Folded component order groups each implied directory with its children
        // without allocating a separate entry for every path prefix.
        files.sort_unstable_by(|a, b| compare_paths(&a.path, &b.path));
        if files.windows(2).any(|pair| collides(&pair[0].path, &pair[1].path)) {
            return Err(Collision);
        }
        if !REQUIRED.iter().all(|path| files.iter().any(|file| file.path == *path)) {
            return Err(MissingRequired);
        }
        Ok(Self(files))
    }

    pub(super) fn files(&self) -> &[FileRecord] {
        &self.0
    }
}

fn compare_paths(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.split('/'), b.split('/'));
    loop {
        match (a.next(), b.next()) {
            (Some(left), Some(right)) => {
                let order = folded_bytes(left).cmp(folded_bytes(right));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (left, right) => return left.is_some().cmp(&right.is_some()),
        }
    }
}

fn folded_bytes(name: &str) -> impl Iterator<Item = u8> + '_ {
    name.bytes().map(|byte| byte.to_ascii_lowercase())
}

fn collides(a: &str, b: &str) -> bool {
    for (left, right) in a.split('/').zip(b.split('/')) {
        if left != right {
            return left.eq_ignore_ascii_case(right);
        }
    }
    true // Duplicate or a file occupying an implied parent directory.
}

fn parse_digest(hex: &str) -> Option<[u8; 32]> {
    fn nibble(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            _ => None,
        }
    }
    if hex.len() != 64 {
        return None;
    }
    let mut digest = [0; 32];
    for (out, pair) in digest.iter_mut().zip(hex.as_bytes().chunks_exact(2)) {
        *out = nibble(pair[0])? << 4 | nibble(pair[1])?;
    }
    Some(digest)
}

// Relative member-name policy from scripts/windows/split-runtime-verify.mjs.
fn safe_component(name: &str) -> bool {
    if name.is_empty() || name.len() > 120 || name.ends_with('.')
        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._@+-".contains(&b))
    {
        return false;
    }
    let name = name.to_ascii_lowercase();
    let stem = name.split('.').next().unwrap_or_default();
    let device = matches!(stem, "con" | "prn" | "aux" | "nul") ||
        (stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.as_bytes()[3].is_ascii_digit());
    // Other reserved devices contain '$', already rejected by the ASCII policy.
    let exact = matches!(name.as_str(),
        ".git" | ".git-credentials" | ".gitconfig" | ".ssh" | ".gnupg" | ".aws" |
        ".azure" | ".kube" | ".docker" | ".config" | ".npmrc" | ".netrc" | ".pypirc" |
        ".pi" | ".gentle-shell");
    let suffix = matches!(name.rsplit_once('.').map(|(_, ext)| ext),
        Some("pem" | "key" | "ppk" | "pfx" | "p12" | "kdbx" | "zip" | "7z" | "rar" | "tar" | "tgz" | "gz"));
    let prefix = [
        ".env", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credential", "credentials",
        "secret", "secrets", "password", "passwords", "token", "tokens", "privatekey",
        "privatekeys", "private-key", "private-keys", "private_key", "private_keys", "auth",
        "account", "accounts", "audit", "users", "appdata", "profile", "profiles", "session",
        "sessions",
    ].iter().any(|word| {
        name.strip_prefix(word).is_some_and(|rest| rest.is_empty() || rest.starts_with(['.', '_', '-']))
    });
    !(device || exact || suffix || prefix)
}

impl FileRecord {
    pub(super) fn path(&self) -> &str {
        &self.path
    }

    /// Read from the caller's retained handle, positioned at the beginning.
    /// Reads at most the declared length plus one byte to detect extra data.
    pub(super) fn verify(&self, reader: impl Read) -> Result<(), ManifestError> {
        let mut reader = reader.take(self.size + 1);
        let mut hash = Sha256::new();
        let mut buf = [0; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => hash.update(&buf[..n]),
                Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => return Err(ManifestError::Read),
            }
        }
        if reader.limit() != 1 {
            return Err(ManifestError::FileSize);
        }
        if <[u8; 32]>::from(hash.finalize()) != self.digest {
            return Err(ManifestError::FileDigest);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Exact T0 JSON.stringify output for inert three-byte files, LF included.
    // Raw pin calculated independently with Node's crypto over that producer format.
    const GOLDEN_PIN: [u8; 32] = [
        0x17, 0x32, 0xf5, 0x20, 0xcf, 0x5e, 0xa4, 0x34, 0x3f, 0x8e, 0xd1, 0xaf, 0x66, 0x75,
        0x37, 0x62, 0x9a, 0xa5, 0x7d, 0x20, 0xf9, 0xb0, 0x7d, 0x2f, 0x26, 0xa7, 0xdd, 0x2f,
        0xcc, 0x7b, 0xca, 0x87,
    ];
    const ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const CORE: [&str; 7] = [
        "bin/engram.exe",
        "bin/pi.exe",
        "bin/private-storage.exe",
        "daemon/cli.mjs",
        "daemon/node_modules/gentle-pi/bin/gentle-shell.mjs",
        "node/node.exe",
        "ui/index.html",
    ];

    fn fixture(paths: &[&str]) -> String {
        let records: Vec<_> = paths.iter().map(|path| format!(
            r#"{{"path":{},"type":"file","size":3,"sha256":"{ABC}"}}"#, serde_json::to_string(path).unwrap()
        )).collect();
        format!(
            "{{\"schema\":1,\"target\":\"windows-x64\",\"shell\":\"5.0.0\",\"pi\":\"1.6.0\",\"files\":[{}]}}\n",
            records.join(",")
        )
    }

    fn refuse(raw: impl AsRef<[u8]>, error: ManifestError) {
        let raw = raw.as_ref();
        assert_eq!(Manifest::decode(raw, Sha256::digest(raw).into()).err(), Some(error));
    }

    #[test]
    fn accepts_pinned_producer_format() {
        let raw = fixture(&CORE);
        let manifest = Manifest::decode(raw.as_bytes(), GOLDEN_PIN).unwrap();
        assert_eq!(manifest.files().iter().map(FileRecord::path).collect::<Vec<_>>(), CORE);
    }

    #[test]
    fn bounds_and_authenticates_before_json() {
        assert_eq!(Manifest::decode(b"{", GOLDEN_PIN).err(), Some(ManifestError::ManifestDigest));
        refuse(b"{", ManifestError::Schema);
        let mut raw = fixture(&CORE).into_bytes();
        raw.resize(MAX_MANIFEST, b' ');
        assert!(Manifest::decode(&raw, Sha256::digest(&raw).into()).is_ok());
        raw.push(b' ');
        assert_eq!(Manifest::decode(&raw, GOLDEN_PIN).err(), Some(ManifestError::TooLarge));
    }

    #[test]
    fn refuses_nonobjects_duplicate_and_unknown_fields() {
        let raw = fixture(&CORE);
        for (old, new) in [
            ("\"schema\":1", "\"schema\":1,\"sch\\u0065ma\":1"),
            ("\"schema\":1", "\"schema\":1,\"other\":0"),
            ("\"size\":3", "\"size\":3,\"size\":3"),
            ("\"size\":3", "\"size\":3,\"other\":0"),
        ] {
            refuse(raw.replacen(old, new, 1), ManifestError::Schema);
        }
        refuse(r#"[1,"windows-x64","5.0.0","1.6.0",[]]"#, ManifestError::Schema);
        refuse(raw.replacen("\"files\":[", "\"files\":[[\"a\",\"file\",0,\"\"],", 1), ManifestError::Schema);
    }

    #[test]
    fn requires_exact_tuple_core_and_canonical_records() {
        let raw = fixture(&CORE);
        for (old, new) in [("schema\":1", "schema\":2"), ("windows-x64", "windows-arm64"), ("5.0.0", "5.0.1"), ("1.6.0", "1.6.1")] {
            refuse(raw.replacen(old, new, 1), ManifestError::Tuple);
        }
        for i in 0..CORE.len() {
            let mut paths = CORE.to_vec();
            paths.remove(i);
            refuse(fixture(&paths), ManifestError::MissingRequired);
        }
        refuse(raw.replacen("node/node.exe", "node/Node.exe", 1), ManifestError::MissingRequired);
        for replacement in [ABC.to_uppercase(), ABC[1..].into(), "x".repeat(64)] {
            refuse(raw.replacen(ABC, &replacement, 1), ManifestError::Record);
        }
        refuse(raw.replacen("\"type\":\"file\"", "\"type\":\"link\"", 1), ManifestError::Record);
        refuse(raw.replacen("\"size\":3", "\"size\":9007199254740992", 1), ManifestError::Record);
        refuse(raw.replacen("\"size\":3", "\"size\":-1", 1), ManifestError::Schema);
    }

    #[test]
    fn rejects_unsafe_members_and_layout_collisions() {
        for path in [
            "../a", "x/./a", "x//a", "/a", "x/", "x\\a", "a:b", "a.", "a ", "a~1",
            "NUL.txt", "COM0.txt", "é", "x/synthetic.TgZ", "x/sessions-inert/a",
            "x/private_keys-inert.txt", "x/.ENV-inert",
        ] {
            refuse(fixture(&[path]), ManifestError::Path);
        }
        let component = "a".repeat(120);
        let longest = format!("{component}/{}", "b".repeat(119));
        let raw = fixture(&[&CORE[..], &[&longest, "x/@a+b-.txt", "x/.ordinary"]].concat());
        assert!(Manifest::decode(raw.as_bytes(), Sha256::digest(&raw).into()).is_ok());
        refuse(fixture(&[&format!("{longest}b")]), ManifestError::Path);
        refuse(fixture(&[&format!("{component}a")]), ManifestError::Path);
        for paths in [
            &["a", "a"][..], &["a", "A"], &["a/x", "A/y"], &["a", "a-/b", "a/x"],
            &["a/x", "a"], &["a/b/x", "a/B/y"],
        ] {
            refuse(fixture(paths), ManifestError::Collision);
        }
    }

    #[test]
    fn verifies_only_bounded_bytes_from_reader() {
        let raw = fixture(&CORE);
        let manifest = Manifest::decode(raw.as_bytes(), GOLDEN_PIN).unwrap();
        let file = &manifest.files()[0];
        assert_eq!(file.verify(&b"abc"[..]), Ok(()));
        assert_eq!(file.verify(&b"ab"[..]), Err(ManifestError::FileSize));
        let mut extra = &b"abcde"[..];
        assert_eq!(file.verify(&mut extra), Err(ManifestError::FileSize));
        assert_eq!(extra, b"e");
        assert_eq!(file.verify(&b"abd"[..]), Err(ManifestError::FileDigest));
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::Other.into())
            }
        }
        assert_eq!(file.verify(Broken), Err(ManifestError::Read));
    }
}
