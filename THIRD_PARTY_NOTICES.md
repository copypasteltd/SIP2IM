# Third-party notices

This is an inventory of **direct dependency license declarations**, checked locally on 2026-11-20. An SPDX identifier below reports metadata, not independent confirmation of the license text, copyright holders, or distribution obligations. It is not a complete release notice or legal review.

## npm: locally corroborated declarations

The version and license columns were read from each direct dependency's installed `package.json` and match the corresponding entry in that component's `package-lock.json`. Categories are those in the project manifests; build tooling may contribute code to a release, so the category alone does not determine what is shipped. Internal `@voipgw/protocol` is a local project dependency, not treated here as a third-party package.

| Component | Dependency | Category | Installed and locked version | Declared license |
|---|---|---|---|---|
| core | @node-rs/argon2 | runtime | 2.2.2 | MIT |
| core | fastify | runtime | 5.12.8 | MIT |
| core | libphonenumber-js | runtime | 1.13.17 | MIT |
| core | pg | runtime | 8.23.1 | MIT |
| core | smol-toml | runtime | 1.9.1 | BSD-3-Clause |
| core | ulid | runtime | 2.4.0 | MIT |
| core | ws | runtime | 8.23.0 | MIT |
| core | zod | runtime | 3.25.76 | MIT |
| core | @types/node | dev | 22.20.5 | MIT |
| core | @types/pg | dev | 8.23.1 | MIT |
| core | @types/ws | dev | 8.18.2 | MIT |
| core | tsup | dev | 8.5.1 | MIT |
| core | typescript | dev | 5.9.3 | Apache-2.0 |
| core | vitest | dev | 3.2.7 | MIT |
| web | @tanstack/react-query | runtime | 5.108.1 | MIT |
| web | i18next | runtime | 25.10.10 | MIT |
| web | qrcode | runtime | 1.5.4 | MIT |
| web | react | runtime | 19.3.1 | MIT |
| web | react-dom | runtime | 19.3.1 | MIT |
| web | react-i18next | runtime | 15.7.4 | MIT |
| web | react-router-dom | runtime | 7.18.6 | MIT |
| web | zustand | runtime | 5.1.0 | MIT |
| web | @eslint/js | dev | 9.39.5 | MIT |
| web | @tailwindcss/vite | dev | 4.3.5 | MIT |
| web | @testing-library/jest-dom | dev | 6.9.1 | MIT |
| web | @testing-library/react | dev | 16.3.3 | MIT |
| web | @types/qrcode | dev | 1.5.6 | MIT |
| web | @types/react | dev | 19.3.0 | MIT |
| web | @types/react-dom | dev | 19.3.0 | MIT |
| web | @vitejs/plugin-react | dev | 4.7.0 | MIT |
| web | eslint | dev | 9.39.5 | MIT |
| web | eslint-plugin-jsx-a11y | dev | 6.10.2 | MIT |
| web | eslint-plugin-react-hooks | dev | 5.2.0 | MIT |
| web | globals | dev | 15.15.0 | MIT |
| web | jsdom | dev | 26.1.0 | MIT |
| web | tailwindcss | dev | 4.3.5 | MIT |
| web | typescript | dev | 5.9.3 | Apache-2.0 |
| web | typescript-eslint | dev | 8.73.0 | MIT |
| web | vite | dev | 6.4.6 | MIT |
| web | vitest | dev | 3.2.7 | MIT |
| packages/protocol | zod | runtime | 3.25.76 | MIT |
| packages/protocol | eslint | dev | 9.39.5 | MIT |
| packages/protocol | typescript | dev | 5.9.3 | Apache-2.0 |
| packages/protocol | typescript-eslint | dev | 8.73.0 | MIT |

## Unverified declarations

| Component | Direct declaration | Scope | License / resolution status |
|---|---|---|---|
| tools/device-simulator | ws ^8.23.0 | runtime | Unknown for this component: no local `node_modules/ws/package.json` or root installation/lockfile was found. Core's separately installed ws 8.23.0 declares MIT, but does not establish the simulator's resolved package. |
| android/app | com.squareup.okhttp3:okhttp:3.12.13 | implementation | Unknown; local license metadata not verified. |
| android/app | androidx.multidex:multidex:2.0.1 | implementation | Unknown; local license metadata not verified. |
| android/app | dev.rikka.shizuku:api:13.1.5 | implementation | Unknown; local license metadata not verified. |
| android/app | dev.rikka.shizuku:provider:13.1.5 | implementation | Unknown; local license metadata not verified. |
| android/app and android/protocol | junit:junit:4.13.2 | test | Unknown; local license metadata not verified. |
| android | com.android.application plugin 8.7.3 | build | Unknown; local license metadata not verified. |
| android | Kotlin android and jvm plugins 1.9.25 | build | Unknown; local license metadata not verified. |
| adapters/telegram | setuptools >=61 | build system | Unknown; installed version and license not verified. Project runtime dependencies are declared empty. |

The root, QQ adapter, and Shizuku autostart npm manifests declare no direct npm dependencies. Android's `:protocol` is an internal project dependency. No project Gradle, Poetry, uv, or Pipfile lockfile was found; npm lockfiles were found for core, web, and packages/protocol. The core lockfile also contains an internal protocol snapshot whose dev dependencies differ from its current manifest; the protocol table uses its own current manifest and lockfile.

## Copyleft and release limitations

No copyleft license is declared in the **npm direct dependencies corroborated above**. This does not establish that the Android/Python unknowns, transitive dependencies, platform-specific native packages, bundled assets, or build outputs are copyleft-free. Transitive dependencies, installed license files and copyright notices, Gradle cache artifacts, Python distributions, toolchains, and shipped artifacts were not exhaustively examined. Before release, identify the actual distributed dependency graph and bundled materials, verify their licenses and versions, and include applicable full license texts and copyright/NOTICE material. No dependency installation, modification, or network access was used for this inventory.

## Telegram optional messaging dependency research

The optional Telethon backend declares Telethon 1.41.2 and transitive candidates pyaes 1.6.1, rsa 4.9.1 and pyasn1 0.6.1. PyPI metadata reported MIT, MIT, Apache-2.0 and BSD-2-Clause respectively. These distributions and their complete dependency/license texts were not locally installed or independently verified; lock and audit all shipped artifacts before release. These declarations do not establish any Telegram voice capability.
