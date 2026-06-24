# ASMX

Multi-architecture assembly execution playground for web browsers.

Powered by [Capstone.js](https://alexaltea.github.io/capstone.js/), [Keystone.js](https://alexaltea.github.io/keystone.js/), [Unicorn.js](https://alexaltea.github.io/unicorn.js/). Everything else is pure vanilla JS/CSS.

## Features

- Multi-architecture support: x86, ARM, AArch64, MIPS, PowerPC, SPARC, S390X.
- Live dis/assembling editor with control-flow visualization.
- In-browser emulation with stepping controls: run, pause, step-in, step-over, step-out, reset.
- Breakpoints and conditional breakpoints supporting arbitrary expressions.
- Register viewing/editing, with value inspection in different formats.
- Memory and stack viewing/editing, with address auto-tracking.
- Import/export the entire memory state as ELF binaries.
- Shareable URLs that encode memory and CPU state.

## Building

Clone this repository and run:

```sh
npm install
npm run build
```

These commands generate all the files in the `build/` directory, which `index.html` depends on at runtime. To serve the app locally after building, run `npm run serve`.

## Third-party licenses

This project relies on the following open-source work:

- [**Capstone.js**](https://alexaltea.github.io/capstone.js/): Released under BSD 3-Clause license.\
  https://github.com/AlexAltea/capstone.js/blob/master/LICENSE
- [**Keystone.js**](https://alexaltea.github.io/keystone.js/): Released under GPLv2.0 license.\
  https://github.com/AlexAltea/keystone.js/blob/master/LICENSE
- [**Unicorn.js**](https://alexaltea.github.io/unicorn.js/): Released under GPLv2.0 license.\
  https://github.com/AlexAltea/unicorn.js/blob/master/LICENSE
- [**Codicons**](https://github.com/microsoft/vscode-codicons): Released under CC-BY-4.0 license.\
  https://github.com/microsoft/vscode-codicons/blob/main/LICENSE
- [**Feather**](https://feathericons.com/): Released under MIT license.\
  https://github.com/feathericons/feather/blob/main/LICENSE
