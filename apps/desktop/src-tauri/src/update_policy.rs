use semver::Version;
use serde::Deserialize;
#[derive(Deserialize)]
pub struct Release {
    pub tag_name: String,
    pub draft: bool,
    pub prerelease: bool,
}

// This build is explicitly QA. Stable releases can never cross this channel.
fn release_version(release: &Release) -> Option<Version> {
    if release.draft || !release.prerelease {
        return None;
    }
    let rest = release.tag_name.strip_prefix("macos-qa-v")?;
    let (version, build) = rest.rsplit_once('-')?;
    if build.is_empty() || !build.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let version = Version::parse(version).ok()?;
    if !version.pre.is_empty() || !version.build.is_empty() {
        return None;
    }
    Some(version)
}

pub fn latest(releases: &[Release], current: &Version) -> Option<(String, Version)> {
    releases
        .iter()
        .filter_map(|r| {
            let version = release_version(r)?;
            (version > *current).then(|| (r.tag_name.clone(), version))
        })
        .max_by(|a, b| a.1.cmp(&b.1))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release(tag: &str) -> Release {
        Release {
            tag_name: tag.into(),
            draft: false,
            prerelease: true,
        }
    }
    #[test]
    fn refuses_cross_channel_drafts_and_noncanonical_versions() {
        for tag in [
            "v1.2.0",
            "macos-qa-v1.2-1",
            "macos-qa-v1.2.0-beta-1",
            "macos-qa-v1.2.0-../x",
            "macos-qa-v1.2.0-",
        ] {
            assert!(release_version(&release(tag)).is_none());
        }
        let mut r = release("macos-qa-v1.2.0-1");
        r.draft = true;
        assert!(release_version(&r).is_none());
        r.draft = false;
        r.prerelease = false;
        assert!(release_version(&r).is_none());
    }
    #[test]
    fn selects_numeric_semver_without_downgrades_or_same_version_reinstalls() {
        let releases = vec![release("macos-qa-v1.9.0-1"), release("macos-qa-v1.10.0-1")];
        assert_eq!(
            latest(&releases, &Version::parse("1.9.0").unwrap())
                .unwrap()
                .1
                .to_string(),
            "1.10.0"
        );
        assert!(latest(&releases, &Version::parse("1.10.0").unwrap()).is_none());
        assert!(latest(&releases, &Version::parse("2.0.0").unwrap()).is_none());
    }
}
