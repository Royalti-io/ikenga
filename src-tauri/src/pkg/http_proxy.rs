//! Pure, IO-free policy core for `host.fetch` (ADR-017, WP-04).
//!
//! The Tauri command (`commands/pkg_fetch.rs`) is the thin IO wrapper; every
//! security decision that can be made without touching the network lives here
//! so it is unit-testable with no running shell. This module:
//!
//! - matches a request URL against the pkg's `permissions.net` globs (the URL
//!   allowlist — same matcher surface used for ordinary `net` declarations),
//! - classifies a resolved IP as private/loopback/link-local/etc. for the SSRF
//!   guard,
//! - validates the request method + caps the response size,
//! - decides whether a redirect hop may be followed (allowlist re-check) and
//!   whether the injected auth header must be dropped (cross-origin hop).
//!
//! Everything fails closed: an unparseable URL, an unmatched glob, or a
//! private-IP target is a refusal, never a silent pass.

use std::net::IpAddr;

use glob::Pattern;
use url::Url;

/// Frozen refusal reasons. The FE branches on these; keep the wire strings
/// stable. A non-2xx HTTP *status* is NOT a refusal — only gate/guard/transport
/// failures surface here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchRefusal {
    /// `capabilities.http` absent on the manifest.
    CapabilityMissing,
    /// Pkg is not trusted-for-elevated (provenance/signature gate).
    NotTrusted,
    /// URL didn't match any `permissions.net` glob.
    UrlNotAllowed,
    /// Method not in the small allowed set, or not a string.
    MethodNotAllowed,
    /// URL won't parse, isn't absolute, or uses a non-http(s) scheme.
    BadUrl,
    /// Scheme is `http:` (plaintext) — rejected unless a net glob is explicitly
    /// an `http://` prefix (loopback/dev opt-in via the allowlist, see Safety).
    InsecureScheme,
    /// Resolved host is loopback/private/link-local/CGNAT/ULA/multicast/etc.
    /// and no net glob explicitly allow-listed that host.
    SsrfBlocked,
    /// The auth secret named by `auth_secret` couldn't be resolved/was empty.
    CredentialMissing,
    /// More than the redirect budget, or a redirect left the allowlist.
    TooManyRedirects,
    /// Response exceeded the size cap before completing.
    ResponseTooLarge,
    /// Network/transport error.
    NetworkError,
    /// Request timed out.
    Timeout,
}

impl FetchRefusal {
    /// Stable wire string surfaced to the FE in `{ ok:false, reason }`.
    pub fn as_str(self) -> &'static str {
        match self {
            FetchRefusal::CapabilityMissing => "capability-missing",
            FetchRefusal::NotTrusted => "not-trusted",
            FetchRefusal::UrlNotAllowed => "url-not-allowed",
            FetchRefusal::MethodNotAllowed => "method-not-allowed",
            FetchRefusal::BadUrl => "bad-url",
            FetchRefusal::InsecureScheme => "insecure-scheme",
            FetchRefusal::SsrfBlocked => "ssrf-blocked",
            FetchRefusal::CredentialMissing => "credential-missing",
            FetchRefusal::TooManyRedirects => "too-many-redirects",
            FetchRefusal::ResponseTooLarge => "response-too-large",
            FetchRefusal::NetworkError => "network-error",
            FetchRefusal::Timeout => "timeout",
        }
    }

    /// True for refusals that indicate *misuse* (worth an audit row) vs.
    /// transient transport failures (network/timeout — noise, not policy).
    pub fn is_misuse(self) -> bool {
        matches!(
            self,
            FetchRefusal::CapabilityMissing
                | FetchRefusal::NotTrusted
                | FetchRefusal::UrlNotAllowed
                | FetchRefusal::MethodNotAllowed
                | FetchRefusal::BadUrl
                | FetchRefusal::InsecureScheme
                | FetchRefusal::SsrfBlocked
        )
    }
}

/// The methods a pkg may request. A deliberately small, safe set; anything
/// else is `MethodNotAllowed`. Upper-cased before comparison.
const ALLOWED_METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

/// Default per-request response-size cap (1 MiB). The command may pass a
/// smaller per-call value but never larger than `MAX_RESPONSE_BYTES`.
pub const DEFAULT_RESPONSE_BYTES: u64 = 1024 * 1024;
/// Hard ceiling on the response-size cap (8 MiB) — a malicious/huge response
/// can't OOM the shell because the streamed reader stops here.
pub const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
/// Default per-request timeout (15s) and ceiling (60s).
pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;
pub const MAX_TIMEOUT_MS: u64 = 60_000;
/// Maximum number of redirect hops followed (each re-validated). 0 would mean
/// "never follow"; 3 matches the design's manual-follow budget.
pub const MAX_REDIRECTS: u8 = 3;

/// Normalize + validate the request method. `None`/empty defaults to GET.
pub fn normalize_method(raw: Option<&str>) -> Result<String, FetchRefusal> {
    let m = raw.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("GET");
    let upper = m.to_ascii_uppercase();
    if ALLOWED_METHODS.contains(&upper.as_str()) {
        Ok(upper)
    } else {
        Err(FetchRefusal::MethodNotAllowed)
    }
}

/// Clamp a requested response-size cap into `[1, MAX_RESPONSE_BYTES]`,
/// defaulting to `DEFAULT_RESPONSE_BYTES`.
pub fn clamp_response_bytes(requested: Option<u64>) -> u64 {
    requested
        .filter(|&n| n > 0)
        .unwrap_or(DEFAULT_RESPONSE_BYTES)
        .min(MAX_RESPONSE_BYTES)
}

/// Clamp a requested timeout into `[1, MAX_TIMEOUT_MS]`, defaulting to
/// `DEFAULT_TIMEOUT_MS`.
pub fn clamp_timeout_ms(requested: Option<u64>) -> u64 {
    requested
        .filter(|&n| n > 0)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .min(MAX_TIMEOUT_MS)
}

/// Parse + scheme-check a request URL. Must be an absolute http(s) URL with a
/// host. `http:` is only honored when an explicit `http://`-prefixed net glob
/// allow-lists it (the caller passes `allow_http`); otherwise plaintext is
/// refused to block downgrade + loopback smuggling.
pub fn parse_request_url(raw: &str, allow_http: bool) -> Result<Url, FetchRefusal> {
    let url = Url::parse(raw).map_err(|_| FetchRefusal::BadUrl)?;
    match url.scheme() {
        "https" => {}
        "http" if allow_http => {}
        "http" => return Err(FetchRefusal::InsecureScheme),
        _ => return Err(FetchRefusal::BadUrl),
    }
    if url.host_str().is_none() {
        return Err(FetchRefusal::BadUrl);
    }
    Ok(url)
}

/// True when the URL matches at least one `permissions.net` glob. A net entry
/// is a URL prefix/glob (e.g. `https://api.twenty.com/`, `https://*.twenty.com/*`).
/// We glob-match against the full normalized URL string; a bare prefix (no
/// wildcards) is treated as a `startsWith` by appending `*`. Empty allowlist =
/// nothing allowed (fail-closed).
pub fn url_matches_net_allowlist(url: &Url, net: &[String]) -> bool {
    let target = url.as_str();
    net.iter().any(|raw| glob_or_prefix_match(raw, target))
}

/// True when ANY net glob explicitly names this host (used to let the SSRF
/// guard permit an intentionally-loopback/private target the author opted into,
/// e.g. a dev `http://127.0.0.1:3000/` entry). We compare the glob's host
/// portion, not the whole URL, so a path-scoped entry still counts.
pub fn net_allowlist_names_host(host: &str, net: &[String]) -> bool {
    net.iter().any(|raw| {
        Url::parse(raw)
            .ok()
            .and_then(|u| u.host_str().map(|h| h.eq_ignore_ascii_case(host)))
            .unwrap_or(false)
    })
}

/// True when the net allowlist contains at least one `http://` (plaintext)
/// entry — the only condition under which `parse_request_url` honors `http:`.
pub fn net_allowlist_permits_http(net: &[String]) -> bool {
    net.iter().any(|raw| raw.starts_with("http://"))
}

fn glob_or_prefix_match(raw: &str, target: &str) -> bool {
    // A pattern with no wildcard chars is a prefix match (startsWith).
    let pattern = if raw.contains('*') || raw.contains('?') || raw.contains('[') {
        raw.to_string()
    } else {
        format!("{raw}*")
    };
    match Pattern::new(&pattern) {
        Ok(p) => p.matches(target),
        Err(_) => target.starts_with(raw), // malformed glob → fall back to prefix
    }
}

/// SSRF classifier: is this resolved IP one we must refuse to connect to unless
/// the net allowlist explicitly named the host? Covers loopback, private
/// (RFC1918), link-local, CGNAT (100.64/10), ULA (fc00::/7), multicast,
/// unspecified, and IPv4-mapped equivalents.
pub fn ip_is_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || is_cgnat_v4(v4)
        }
        IpAddr::V6(v6) => {
            // Check v6-native classifications FIRST. `to_ipv4()` maps `::1`
            // (loopback) to the IPv4-compatible `0.0.0.1`, which is NOT itself
            // loopback — so a naive map-then-classify would let `::1` through.
            if v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || is_unique_local_v6(v6)
                || is_link_local_v6(v6)
            {
                return true;
            }
            // Only AFTER the v6-native checks: an IPv4-mapped address
            // (`::ffff:a.b.c.d`) is classified by the embedded v4 so a mapped
            // loopback/private target is still caught.
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return ip_is_blocked(IpAddr::V4(mapped));
            }
            false
        }
    }
}

fn is_cgnat_v4(v4: std::net::Ipv4Addr) -> bool {
    // 100.64.0.0/10
    let o = v4.octets();
    o[0] == 100 && (o[1] & 0xC0) == 0x40
}

fn is_unique_local_v6(v6: std::net::Ipv6Addr) -> bool {
    // fc00::/7
    (v6.segments()[0] & 0xFE00) == 0xFC00
}

fn is_link_local_v6(v6: std::net::Ipv6Addr) -> bool {
    // fe80::/10
    (v6.segments()[0] & 0xFFC0) == 0xFE80
}

/// Decide a redirect hop: returns the validated next `Url` to follow, or a
/// refusal. The hop must (1) parse + scheme-check, (2) still match the net
/// allowlist. The caller separately decides whether to DROP the auth header
/// (any cross-origin hop) via `is_cross_origin`.
pub fn validate_redirect(
    location: &str,
    base: &Url,
    net: &[String],
    allow_http: bool,
) -> Result<Url, FetchRefusal> {
    // Resolve relative Location against the current URL.
    let next = base.join(location).map_err(|_| FetchRefusal::BadUrl)?;
    match next.scheme() {
        "https" => {}
        "http" if allow_http => {}
        "http" => return Err(FetchRefusal::InsecureScheme),
        _ => return Err(FetchRefusal::BadUrl),
    }
    if next.host_str().is_none() {
        return Err(FetchRefusal::BadUrl);
    }
    if !url_matches_net_allowlist(&next, net) {
        return Err(FetchRefusal::TooManyRedirects); // left the allowlist
    }
    Ok(next)
}

/// Origin = (scheme, host, port). Used to decide auth-header drop on redirect.
pub fn is_cross_origin(a: &Url, b: &Url) -> bool {
    a.scheme() != b.scheme()
        || a.host_str() != b.host_str()
        || a.port_or_known_default() != b.port_or_known_default()
}

/// Reject a header value (or name) carrying CR/LF — request-splitting guard.
pub fn header_value_is_safe(v: &str) -> bool {
    !v.contains('\r') && !v.contains('\n')
}

/// Pkg-supplied header keys the iframe may NEVER set — the shell owns auth and
/// the connection. Compared case-insensitively. `proxy-*` is handled separately.
const HEADER_DENYLIST: &[&str] = &["authorization", "cookie", "host", "content-length"];

/// True when a pkg-supplied header key is forbidden. `auth_header` (the
/// configured injected header, e.g. a custom `X-Api-Key`) is also denied so the
/// pkg can't pre-set/override the credential. All comparisons case-insensitive.
pub fn header_key_is_denied(key: &str, auth_header: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    if HEADER_DENYLIST.contains(&lower.as_str()) {
        return true;
    }
    if lower.starts_with("proxy-") {
        return true;
    }
    lower == auth_header.to_ascii_lowercase()
}

/// Response headers the shell strips before returning them to the iframe so the
/// proxy can't seed iframe-readable cookies.
pub fn response_header_is_stripped(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower == "set-cookie" || lower == "set-cookie2"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn method_normalization_and_allowlist() {
        assert_eq!(normalize_method(None).unwrap(), "GET");
        assert_eq!(normalize_method(Some("post")).unwrap(), "POST");
        assert_eq!(normalize_method(Some("")).unwrap(), "GET");
        assert!(normalize_method(Some("CONNECT")).is_err());
        assert!(normalize_method(Some("TRACE")).is_err());
    }

    #[test]
    fn caps_clamp() {
        assert_eq!(clamp_response_bytes(None), DEFAULT_RESPONSE_BYTES);
        assert_eq!(clamp_response_bytes(Some(0)), DEFAULT_RESPONSE_BYTES);
        assert_eq!(clamp_response_bytes(Some(100)), 100);
        assert_eq!(clamp_response_bytes(Some(u64::MAX)), MAX_RESPONSE_BYTES);
        assert_eq!(clamp_timeout_ms(Some(u64::MAX)), MAX_TIMEOUT_MS);
        assert_eq!(clamp_timeout_ms(None), DEFAULT_TIMEOUT_MS);
    }

    #[test]
    fn https_required_unless_allowlist_permits_http() {
        assert!(parse_request_url("https://api.twenty.com/x", false).is_ok());
        assert_eq!(
            parse_request_url("http://api.twenty.com/x", false).unwrap_err(),
            FetchRefusal::InsecureScheme
        );
        // explicit http opt-in
        assert!(parse_request_url("http://127.0.0.1:3000/x", true).is_ok());
        // non-http scheme is always bad
        assert_eq!(
            parse_request_url("file:///etc/passwd", true).unwrap_err(),
            FetchRefusal::BadUrl
        );
        // relative / non-absolute
        assert_eq!(
            parse_request_url("/rest/people", false).unwrap_err(),
            FetchRefusal::BadUrl
        );
    }

    #[test]
    fn net_allowlist_prefix_and_glob() {
        let net = s(&["https://api.twenty.com/"]);
        let ok = parse_request_url("https://api.twenty.com/rest/people?limit=1", false).unwrap();
        assert!(url_matches_net_allowlist(&ok, &net));
        // different host denied
        let evil = parse_request_url("https://evil.example.com/rest", false).unwrap();
        assert!(!url_matches_net_allowlist(&evil, &net));
        // host-prefix confusion: a malicious host that merely starts with the
        // allowed string must NOT pass (prefix is on the full URL incl. scheme+host).
        let confuse =
            parse_request_url("https://api.twenty.com.evil.example/rest", false).unwrap();
        assert!(!url_matches_net_allowlist(&confuse, &net));
        // wildcard glob
        let glob = s(&["https://*.twenty.com/*"]);
        let sub = parse_request_url("https://crm.twenty.com/rest", false).unwrap();
        assert!(url_matches_net_allowlist(&sub, &glob));
    }

    #[test]
    fn empty_net_allowlist_denies_all() {
        let url = parse_request_url("https://api.twenty.com/x", false).unwrap();
        assert!(!url_matches_net_allowlist(&url, &[]));
    }

    #[test]
    fn ssrf_classifier_blocks_private_and_loopback() {
        assert!(ip_is_blocked(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(ip_is_blocked(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5))));
        assert!(ip_is_blocked(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
        assert!(ip_is_blocked(IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))));
        assert!(ip_is_blocked(IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254)))); // cloud metadata
        assert!(ip_is_blocked(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1)))); // CGNAT
        assert!(ip_is_blocked(IpAddr::V4(Ipv4Addr::new(0, 0, 0, 0))));
        assert!(ip_is_blocked(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(ip_is_blocked(IpAddr::V6("fc00::1".parse().unwrap()))); // ULA
        assert!(ip_is_blocked(IpAddr::V6("fe80::1".parse().unwrap()))); // link-local
        // IPv4-mapped loopback must also be caught (rebind/mapping trick).
        assert!(ip_is_blocked(IpAddr::V6("::ffff:127.0.0.1".parse().unwrap())));
        // a public IP is fine
        assert!(!ip_is_blocked(IpAddr::V4(Ipv4Addr::new(140, 82, 121, 4))));
        assert!(!ip_is_blocked(IpAddr::V6("2606:4700:4700::1111".parse().unwrap())));
    }

    #[test]
    fn redirect_must_stay_on_allowlist() {
        let net = s(&["https://api.twenty.com/"]);
        let base = parse_request_url("https://api.twenty.com/rest/a", false).unwrap();
        // same-host redirect ok
        assert!(validate_redirect("/rest/b", &base, &net, false).is_ok());
        // off-allowlist redirect refused
        assert_eq!(
            validate_redirect("https://evil.example/steal", &base, &net, false).unwrap_err(),
            FetchRefusal::TooManyRedirects
        );
        // downgrade to http refused
        assert_eq!(
            validate_redirect("http://api.twenty.com/rest/b", &base, &net, false).unwrap_err(),
            FetchRefusal::InsecureScheme
        );
    }

    #[test]
    fn cross_origin_detection_for_auth_drop() {
        let a = Url::parse("https://api.twenty.com/x").unwrap();
        let same = Url::parse("https://api.twenty.com/y").unwrap();
        let other_host = Url::parse("https://other.twenty.com/x").unwrap();
        let other_port = Url::parse("https://api.twenty.com:8443/x").unwrap();
        assert!(!is_cross_origin(&a, &same));
        assert!(is_cross_origin(&a, &other_host));
        assert!(is_cross_origin(&a, &other_port));
    }

    #[test]
    fn header_denylist_blocks_auth_and_smuggling() {
        assert!(header_key_is_denied("Authorization", "Authorization"));
        assert!(header_key_is_denied("authorization", "X-Api-Key"));
        assert!(header_key_is_denied("Cookie", "Authorization"));
        assert!(header_key_is_denied("Host", "Authorization"));
        assert!(header_key_is_denied("Proxy-Authorization", "Authorization"));
        assert!(header_key_is_denied("content-length", "Authorization"));
        // the configured custom auth header is also denied so the pkg can't pre-set it
        assert!(header_key_is_denied("x-api-key", "X-Api-Key"));
        // an ordinary header is allowed
        assert!(!header_key_is_denied("Accept", "Authorization"));
        assert!(!header_key_is_denied("Content-Type", "Authorization"));
    }

    #[test]
    fn crlf_in_header_value_rejected() {
        assert!(header_value_is_safe("application/json"));
        assert!(!header_value_is_safe("a\r\nX-Evil: 1"));
        assert!(!header_value_is_safe("a\nb"));
    }

    #[test]
    fn set_cookie_stripped_from_response() {
        assert!(response_header_is_stripped("Set-Cookie"));
        assert!(response_header_is_stripped("set-cookie2"));
        assert!(!response_header_is_stripped("content-type"));
    }

    #[test]
    fn net_allowlist_host_and_http_helpers() {
        let net = s(&["https://api.twenty.com/", "http://127.0.0.1:3000/dev"]);
        assert!(net_allowlist_names_host("127.0.0.1", &net));
        assert!(net_allowlist_names_host("api.twenty.com", &net));
        assert!(!net_allowlist_names_host("evil.example", &net));
        assert!(net_allowlist_permits_http(&net));
        assert!(!net_allowlist_permits_http(&s(&["https://only.example/"])));
    }
}
