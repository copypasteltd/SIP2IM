# Shizuku autostart

The service polls only explicitly enrolled serials that are also authorized ADB devices every ten seconds, checks for `shizuku_server`, runs the Shizuku app's installed ADB start script when absent, verifies its process and reports each outcome to core at `127.0.0.1`. Three consecutive failures are visible in the third failure report. stdout/stderr is captured by systemd journald. Offline and unauthorized devices are ignored. Failed reports are logged; they are not queued.

Install Node 20.19–22 and ADB, deploy this directory to the path in the unit, adjust `ExecStart` and `VOIP_CORE_PORT` to the installation, and configure `VOIP_SHIZUKU_SERIALS` as a comma-separated list of explicitly enrolled ADB serials using a root-controlled systemd override. The service fails closed before invoking ADB when the allowlist is absent or invalid. Restart the service after changing it. Then install/enable the unit through the deployment procedure. The official app's start script must exist on each device and USB debugging must already be authorized. This tool does not install Shizuku or authorize devices.

Run isolated tests with `npm test --workspace @voipgw/shizuku-autostart`. Tests use injected fakes and do not invoke ADB or HTTP. Real-device operation, compatibility of the installed Shizuku version, journald, and core integration require separate verification.
