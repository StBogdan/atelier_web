//! Which profile this deployment runs in: the single seam between the self-hosted edition and the
//! hosted one (design, One Artifact, Two Profiles).
//!
//! The difference is configuration, not code. `standalone` answers the design's two ports with the
//! operator's own OIDC issuer and a bucket the user attaches in the browser; `hosted` pairs this
//! process with atelier central, which answers both. Nothing else in the server branches on the
//! profile: the cloud app reads [`Capabilities`] at boot and hides what this deployment has no one to
//! do.

use std::{env, fmt};

/// The name every JSON answer carries, so a client can tell one service from another.
pub const SERVICE: &str = "atelier-web";

/// The two profiles one artifact ships as.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Profile {
    /// No central: identity comes from the operator's own issuer, storage from a bucket attached in
    /// the browser. This is the default, because it is the one that needs nothing else to exist.
    #[default]
    Standalone,
    /// Paired with atelier central, which signs users in and mints bucket credentials.
    Hosted,
}

impl Profile {
    pub fn as_str(self) -> &'static str {
        match self {
            Profile::Standalone => "standalone",
            Profile::Hosted => "hosted",
        }
    }

    /// `self-hosted` and `selfhosted` are accepted because they are what someone types before reading
    /// the README, and the name in the documents is "self-hosted".
    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "standalone" | "self-hosted" | "selfhosted" => Some(Profile::Standalone),
            "hosted" => Some(Profile::Hosted),
            _ => None,
        }
    }
}

impl fmt::Display for Profile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Where the hosted profile's identity, billing and provisioning live. Only what a browser needs:
/// this is served as JSON to every client, so nothing secret belongs in it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Central {
    /// Central's public base URL, without a trailing slash.
    pub url: String,
    /// Where a browser signs in: central's AuthKit entry point, which returns to the cloud app.
    pub login: String,
}

/// How a workspace comes to have a bucket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Storage {
    /// The user attaches their own, and this browser signs with it.
    Attached,
    /// Central provisions one per customer and mints the credential.
    Provisioned,
}

/// What the cloud app asks for at boot, so it can hide what this deployment has no one to do.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Capabilities {
    pub service: &'static str,
    pub profile: &'static str,
    /// Whether there is anywhere to sign in to.
    pub accounts: bool,
    /// The billing that takes the money, or `null` when nothing does.
    pub billing: Option<&'static str>,
    pub storage: Storage,
    /// `null` in the standalone profile, which is the whole of what changes between them.
    pub central: Option<Central>,
}

/// The profile and the ports it implies, resolved once at startup.
#[derive(Debug, Clone)]
pub struct Deployment {
    profile: Profile,
    central: Option<Central>,
}

impl Deployment {
    /// Read the deployment from the environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_parts(
            env::var("ATELIER_PROFILE").ok().as_deref(),
            env::var("ATELIER_CENTRAL_URL").ok().as_deref(),
        )
    }

    /// The same, from values already in hand — which is what the tests use, so they never touch the
    /// process environment.
    pub fn from_parts(profile: Option<&str>, central_url: Option<&str>) -> Result<Self, ConfigError> {
        let profile = match profile {
            None => Profile::default(),
            Some(value) => Profile::parse(value).ok_or_else(|| {
                ConfigError::invalid("ATELIER_PROFILE", value, "expected `standalone` or `hosted`")
            })?,
        };

        // A hosted deployment with nowhere to send a browser is a misconfiguration rather than a
        // poorer deployment, so it stops here instead of failing later at someone's first sign-in.
        let central = match (profile, non_empty(central_url)) {
            (Profile::Hosted, Some(url)) => {
                let url = url.trim_end_matches('/').to_owned();
                Some(Central { login: format!("{url}/auth/login"), url })
            }
            (Profile::Hosted, None) => {
                return Err(ConfigError::missing(
                    "ATELIER_CENTRAL_URL",
                    "the hosted profile needs central's public URL",
                ))
            }
            // The standalone profile is what the operator's own issuer and bucket describe, so a
            // central URL set beside it is simply not used.
            (Profile::Standalone, _) => None,
        };

        Ok(Self { profile, central })
    }

    /// The document the cloud app reads at boot.
    pub fn capabilities(&self) -> Capabilities {
        match self.profile {
            Profile::Standalone => Capabilities {
                service: SERVICE,
                profile: self.profile.as_str(),
                accounts: false,
                billing: None,
                storage: Storage::Attached,
                central: None,
            },
            Profile::Hosted => Capabilities {
                service: SERVICE,
                profile: self.profile.as_str(),
                accounts: true,
                billing: Some("stripe"),
                storage: Storage::Provisioned,
                central: self.central.clone(),
            },
        }
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// A deployment that cannot be configured. Named with the variable and what was wrong with it, since
/// the only place this surfaces is a startup message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    variable: &'static str,
    value: Option<String>,
    detail: &'static str,
}

impl ConfigError {
    fn invalid(variable: &'static str, value: &str, detail: &'static str) -> Self {
        Self { variable, value: Some(value.to_owned()), detail }
    }

    fn missing(variable: &'static str, detail: &'static str) -> Self {
        Self { variable, value: None, detail }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.value {
            Some(value) => write!(f, "{}={value}: {}", self.variable, self.detail),
            None => write!(f, "{} is not set: {}", self.variable, self.detail),
        }
    }
}

impl std::error::Error for ConfigError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(profile: Option<&str>, central: Option<&str>) -> serde_json::Value {
        serde_json::to_value(Deployment::from_parts(profile, central).unwrap().capabilities()).unwrap()
    }

    #[test]
    fn no_configuration_is_the_self_hosted_edition() {
        assert_eq!(Deployment::from_parts(None, None).unwrap().profile, Profile::Standalone);
        assert_eq!(
            json(None, None),
            serde_json::json!({
                "service": "atelier-web",
                "profile": "standalone",
                "accounts": false,
                "billing": null,
                "storage": "attached",
                "central": null,
            })
        );
    }

    #[test]
    fn standalone_ignores_a_central_url_rather_than_using_it() {
        let deployment = Deployment::from_parts(Some("standalone"), Some("https://central.test")).unwrap();
        assert!(deployment.central.is_none());
        assert_eq!(deployment.capabilities().central, None);
    }

    #[test]
    fn hosted_names_central_and_where_to_sign_in() {
        let deployment = Deployment::from_parts(Some("hosted"), Some("https://central.test/")).unwrap();
        assert_eq!(deployment.profile, Profile::Hosted);
        // The trailing slash is dropped, so the login URL never doubles it.
        assert_eq!(deployment.central.as_ref().unwrap().url, "https://central.test");
        assert_eq!(deployment.central.as_ref().unwrap().login, "https://central.test/auth/login");
        assert_eq!(
            json(Some("hosted"), Some("https://central.test/")),
            serde_json::json!({
                "service": "atelier-web",
                "profile": "hosted",
                "accounts": true,
                "billing": "stripe",
                "storage": "provisioned",
                "central": { "url": "https://central.test", "login": "https://central.test/auth/login" },
            })
        );
    }

    #[test]
    fn the_friendly_spellings_of_the_profile_are_accepted() {
        for value in ["standalone", " self-hosted ", "SelfHosted"] {
            assert_eq!(
                Deployment::from_parts(Some(value), None).unwrap().profile,
                Profile::Standalone,
                "{value}"
            );
        }
        assert_eq!(
            Deployment::from_parts(Some(" HOSTED "), Some("https://central.test")).unwrap().profile,
            Profile::Hosted
        );
    }

    #[test]
    fn an_unknown_profile_stops_the_service() {
        let error = Deployment::from_parts(Some("cloudy"), None).unwrap_err();
        assert_eq!(error.variable, "ATELIER_PROFILE");
        assert!(error.to_string().contains("cloudy"), "{error}");
    }

    #[test]
    fn hosted_without_central_is_a_misconfiguration() {
        for missing in [None, Some("   ")] {
            let error = Deployment::from_parts(Some("hosted"), missing).unwrap_err();
            assert_eq!(error.variable, "ATELIER_CENTRAL_URL");
        }
    }
}
