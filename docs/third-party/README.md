# Third-party configuration attribution

`docker/chromium-seccomp.json` is the Docker seccomp profile published by the Microsoft Playwright project:
https://github.com/microsoft/playwright/blob/main/utils/docker/seccomp_profile.json

It is distributed under the Apache License 2.0; the accompanying license is retained in `PLAYWRIGHT-LICENSE`. This configuration attribution does not change Changd's original MIT license or Paul Aschmann attribution. The profile was tested with a non-root, sandboxed Chromium capture in the isolated Cloud Docker runtime. Review kernel/AppArmor compatibility on other hosts separately.
