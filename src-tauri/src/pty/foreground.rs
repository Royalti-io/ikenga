//! Foreground-process detection for managed PTYs.
//!
//! Given a PTY's shell PID, return the foreground process — the one whose
//! pgrp is the controlling terminal's foreground process group (set by
//! `tcsetpgrp`). When the user runs `claude` in a terminal pane, the shell
//! sets `claude` as the foreground PG; that's what we surface to the
//! routing dispatcher so pin clicks can target the right PTY.
//!
//! Linux: parse `/proc/<shell_pid>/stat` (field 8 = `tpgid`), then
//! read `/proc/<tpgid>/comm` and `/proc/<tpgid>/cmdline`. No new deps.
//!
//! macOS: `sysctl(KERN_PROC_PID, shell_pid)` returns a `kinfo_proc`
//! whose `kp_eproc.e_tpgid` is the foreground process group leader of
//! the controlling terminal — the direct semantic equivalent of Linux's
//! `tpgid`. A second sysctl on that PID extracts the basename from
//! `kp_proc.p_comm`. We don't read argv on macOS (KERN_PROCARGS2 is
//! fiddly and the routing dispatcher only filters on `name`).
//!
//! Each lookup is cached for 1 second per PTY to keep the routing hot
//! path off the filesystem on repeated reads.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ForegroundProcess {
    /// PID of the foreground process (the one with the controlling terminal).
    pub pid: i32,
    /// Executable basename (e.g. `"claude"`, `"bash"`, `"vim"`). Matches what
    /// the routing dispatcher uses to detect claude PTYs.
    pub name: String,
    /// Full argv, null-byte-stripped. Empty when the kernel returned no
    /// cmdline (kernel-thread, zombie). Best-effort.
    pub args: Vec<String>,
}

#[derive(Clone)]
struct CacheEntry {
    fetched_at: Instant,
    value: Option<ForegroundProcess>,
}

const CACHE_TTL: Duration = Duration::from_secs(1);

fn cache() -> &'static Mutex<HashMap<i32, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<i32, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Look up the foreground process for a PTY identified by its shell PID
/// (the result of `MasterPty::process_group_leader()`).
///
/// Returns `None` when:
/// - the platform isn't supported (macOS, Windows in v0)
/// - the PID no longer exists (PTY died, race with the wait reaper)
/// - the `tpgid` is invalid (no foreground job; rare but possible)
pub fn lookup(shell_pid: i32) -> Option<ForegroundProcess> {
    // Cache check
    if let Ok(map) = cache().lock() {
        if let Some(entry) = map.get(&shell_pid) {
            if entry.fetched_at.elapsed() < CACHE_TTL {
                return entry.value.clone();
            }
        }
    }

    let value = lookup_uncached(shell_pid);

    if let Ok(mut map) = cache().lock() {
        map.insert(
            shell_pid,
            CacheEntry {
                fetched_at: Instant::now(),
                value: value.clone(),
            },
        );
        // Prune entries older than 30s to keep the cache bounded.
        let now = Instant::now();
        map.retain(|_, entry| now.duration_since(entry.fetched_at) < Duration::from_secs(30));
    }

    value
}

#[cfg(target_os = "linux")]
fn lookup_uncached(shell_pid: i32) -> Option<ForegroundProcess> {
    let stat = std::fs::read_to_string(format!("/proc/{shell_pid}/stat")).ok()?;
    // Format: `pid (comm) state ppid pgrp session tty_nr tpgid ...`.
    // `comm` is parenthesized and can contain spaces, so locate the closing
    // paren and split the rest by whitespace.
    let close = stat.rfind(')')?;
    let tail = &stat[close + 1..];
    let mut fields = tail.split_whitespace();
    let _state  = fields.next()?; // 3
    let _ppid   = fields.next()?; // 4
    let _pgrp   = fields.next()?; // 5
    let _sess   = fields.next()?; // 6
    let _tty_nr = fields.next()?; // 7
    let tpgid: i32 = fields.next()?.parse().ok()?; // 8

    // tpgid == -1 means no controlling terminal foreground group, and
    // tpgid == shell_pid (or its pgrp) means the shell itself is foregrounded
    // — both legitimate, both valid as "what's in front."
    if tpgid <= 0 {
        return None;
    }

    let comm = std::fs::read_to_string(format!("/proc/{tpgid}/comm"))
        .ok()?
        .trim()
        .to_string();
    let cmdline_bytes = std::fs::read(format!("/proc/{tpgid}/cmdline")).ok()?;
    let args: Vec<String> = cmdline_bytes
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect();

    Some(ForegroundProcess {
        pid: tpgid,
        name: comm,
        args,
    })
}

#[cfg(target_os = "macos")]
fn lookup_uncached(shell_pid: i32) -> Option<ForegroundProcess> {
    let shell_info = mac_kinfo_proc(shell_pid)?;
    // e_tpgid: foreground PG leader PID for the controlling terminal.
    // Same semantic as Linux's tpgid (field 8 of /proc/<pid>/stat).
    let tpgid = shell_info.kp_eproc.e_tpgid;
    if tpgid <= 0 {
        return None;
    }

    let fg_info = mac_kinfo_proc(tpgid)?;
    let name = mac_p_comm_string(&fg_info.kp_proc.p_comm);
    if name.is_empty() {
        return None;
    }

    Some(ForegroundProcess {
        pid: tpgid,
        name,
        // KERN_PROCARGS2 parsing skipped — routing only filters on `name`.
        // Linux populates argv for completeness; on macOS the cost/benefit
        // doesn't justify the unsafe sysctl dance.
        args: Vec::new(),
    })
}

#[cfg(target_os = "macos")]
fn mac_kinfo_proc(pid: i32) -> Option<libc::kinfo_proc> {
    use std::mem;
    let mut mib: [libc::c_int; 4] = [
        libc::CTL_KERN,
        libc::KERN_PROC,
        libc::KERN_PROC_PID,
        pid,
    ];
    let mut size: libc::size_t = mem::size_of::<libc::kinfo_proc>();
    // SAFETY: zeroed `kinfo_proc` is a valid POD; sysctl fills it. The mib
    // array and size pointer are stack-local and outlive the call.
    let mut info: libc::kinfo_proc = unsafe { mem::zeroed() };
    let ret = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as libc::c_uint,
            &mut info as *mut _ as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    // sysctl returns 0 on success and writes the actual size. size==0 means
    // the PID doesn't exist (kernel returned an empty record). Both are
    // "no foreground process knowable", same as a missing /proc entry.
    if ret != 0 || size == 0 {
        return None;
    }
    Some(info)
}

#[cfg(target_os = "macos")]
fn mac_p_comm_string(arr: &[libc::c_char]) -> String {
    // p_comm is a fixed-size, null-terminated executable basename
    // (MAXCOMLEN+1 = 17 bytes). Take bytes up to the first null.
    let bytes: Vec<u8> = arr
        .iter()
        .take_while(|&&b| b != 0)
        .map(|&b| b as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn lookup_uncached(_shell_pid: i32) -> Option<ForegroundProcess> {
    // Windows: not implemented. Returning None means the routing dispatcher
    // falls back to side-pane Chat, which is the documented behavior.
    None
}

/// True when the foreground process for `shell_pid` is `claude` (or
/// `claude-code`, or any binary whose basename starts with `claude`).
///
/// The routing dispatcher uses this to filter PTYs when picking the active
/// claude session. Match is on the executable basename so an alias like
/// `claude-code` or a wrapper script named `claude` all qualify.
pub fn is_claude(shell_pid: i32) -> bool {
    lookup(shell_pid)
        .map(|fp| fp.name.starts_with("claude"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_hit_is_consistent() {
        // Self-PID — guaranteed to be a real, observable process. We don't
        // care about the result value, only that two consecutive calls
        // return the same thing (cache hit).
        let pid = std::process::id() as i32;
        let a = lookup(pid);
        let b = lookup(pid);
        assert_eq!(a, b);
    }

    #[test]
    fn lookup_for_nonexistent_pid_is_none() {
        // PID 2^31 - 1 is functionally impossible to be live.
        let result = lookup(i32::MAX - 1);
        assert!(result.is_none());
    }
}
