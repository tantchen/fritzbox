# Changelog

## 0.1.0 – 2026-10-11

- Session login with PBKDF2 and MD5 fallback, cached session id, re-login on 403
- AHA thermostats: typed device list, `setTargetTemperature` with 8–28 °C / `'on'` / `'off'`
- TR-064 host list with digest fallback (taken over from fritz-thermostat)
- No runtime dependencies; own minimal XML reader for the device list
