-- 0008_pkg_install_source.sql
-- Add provenance tracking to installed packages. Distinguishes shell-bundled
-- builtins from registry-installed and locally-sideloaded pkgs so the kernel
-- can enforce uninstall policy and the UI can group / badge correctly.
--
-- Stored as JSON to keep the row open-ended for future Registry fields
-- (publisher_key, signature_url, etc.) without a third migration.
-- Pre-existing rows get a non-null default of `local` and are reconciled at
-- boot — `install_builtins()` re-stamps any rows whose id matches a pkg in
-- `resources/builtin-pkgs/`.

ALTER TABLE pkg_installed
  ADD COLUMN source_json TEXT NOT NULL DEFAULT '{"kind":"local","path":""}';
