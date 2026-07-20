---
'ikenga-desktop': patch
---

Fix in-app updates reading as a mid-process crash on Linux. An app update now
holds at an explicit "installed — Restart to finish" state with a Restart
button, instead of relaunching the moment the install completes and tearing the
window down out from under you (which, with the download bar frozen at the
elevated `dpkg` step, was indistinguishable from a crash even though the update
had actually applied). The opt-in "install app updates automatically" setting
keeps relaunching on its own.

Note: this smooths the *next* update — an update installed by an older build
still relaunches the old way; the Restart-to-finish flow takes effect for
updates applied from this build onward.
