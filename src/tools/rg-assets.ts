export interface RgAsset {version:string;url:string;format:'zip'|'tar.gz';binaryName:'rg'|'rg.exe';archiveSha256:string;binarySha256:string;entries:Record<string,{archivePath:string;sha256:string;maxBytes:number}>}
/** Fixed release artifacts verified against the publisher's release digests. */
export const RG_ASSETS:Readonly<Record<string,RgAsset>>={
  "darwin-arm64": {
    "version": "15.2.0",
    "url": "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin.tar.gz",
    "format": "tar.gz",
    "binaryName": "rg",
    "archiveSha256": "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
    "binarySha256": "a326a1fb48074202e9ad41e4cd1e389eeea372c8c6f7d7e80da81176d5d9430e",
    "entries": {
      "rg": {
        "archivePath": "ripgrep-15.2.0-aarch64-apple-darwin/rg",
        "sha256": "a326a1fb48074202e9ad41e4cd1e389eeea372c8c6f7d7e80da81176d5d9430e",
        "maxBytes": 16777216
      },
      "LICENSE-MIT": {
        "archivePath": "ripgrep-15.2.0-aarch64-apple-darwin/LICENSE-MIT",
        "sha256": "0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f",
        "maxBytes": 65536
      },
      "UNLICENSE": {
        "archivePath": "ripgrep-15.2.0-aarch64-apple-darwin/UNLICENSE",
        "sha256": "7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c",
        "maxBytes": 65536
      }
    }
  },
  "darwin-x64": {
    "version": "15.2.0",
    "url": "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-apple-darwin.tar.gz",
    "format": "tar.gz",
    "binaryName": "rg",
    "archiveSha256": "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
    "binarySha256": "0c9a0066db0d26b640777db88045b0ccdd58509a746700e43e1c4ff8707a5ed0",
    "entries": {
      "rg": {
        "archivePath": "ripgrep-15.2.0-x86_64-apple-darwin/rg",
        "sha256": "0c9a0066db0d26b640777db88045b0ccdd58509a746700e43e1c4ff8707a5ed0",
        "maxBytes": 16777216
      },
      "LICENSE-MIT": {
        "archivePath": "ripgrep-15.2.0-x86_64-apple-darwin/LICENSE-MIT",
        "sha256": "0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f",
        "maxBytes": 65536
      },
      "UNLICENSE": {
        "archivePath": "ripgrep-15.2.0-x86_64-apple-darwin/UNLICENSE",
        "sha256": "7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c",
        "maxBytes": 65536
      }
    }
  },
  "linux-arm64": {
    "version": "15.2.0",
    "url": "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-aarch64-unknown-linux-musl.tar.gz",
    "format": "tar.gz",
    "binaryName": "rg",
    "archiveSha256": "800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915",
    "binarySha256": "c14cdb389f34e504d69e386cfc67d5c5d9a730a990de03ca6910b2a15e30386a",
    "entries": {
      "rg": {
        "archivePath": "ripgrep-15.2.0-aarch64-unknown-linux-musl/rg",
        "sha256": "c14cdb389f34e504d69e386cfc67d5c5d9a730a990de03ca6910b2a15e30386a",
        "maxBytes": 16777216
      },
      "LICENSE-MIT": {
        "archivePath": "ripgrep-15.2.0-aarch64-unknown-linux-musl/LICENSE-MIT",
        "sha256": "0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f",
        "maxBytes": 65536
      },
      "UNLICENSE": {
        "archivePath": "ripgrep-15.2.0-aarch64-unknown-linux-musl/UNLICENSE",
        "sha256": "7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c",
        "maxBytes": 65536
      }
    }
  },
  "linux-x64": {
    "version": "15.2.0",
    "url": "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz",
    "format": "tar.gz",
    "binaryName": "rg",
    "archiveSha256": "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
    "binarySha256": "e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849",
    "entries": {
      "rg": {
        "archivePath": "ripgrep-15.2.0-x86_64-unknown-linux-musl/rg",
        "sha256": "e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849",
        "maxBytes": 16777216
      },
      "LICENSE-MIT": {
        "archivePath": "ripgrep-15.2.0-x86_64-unknown-linux-musl/LICENSE-MIT",
        "sha256": "0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f",
        "maxBytes": 65536
      },
      "UNLICENSE": {
        "archivePath": "ripgrep-15.2.0-x86_64-unknown-linux-musl/UNLICENSE",
        "sha256": "7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c",
        "maxBytes": 65536
      }
    }
  },
  "win32-arm64": {
    "version": "15.2.0",
    "url": "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-aarch64-pc-windows-msvc.zip",
    "format": "zip",
    "binaryName": "rg.exe",
    "archiveSha256": "e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f",
    "binarySha256": "d33a29a9ef03c9f4c03be9e8d88498e6e2d2e566d64cdbdef97f9afc8f13120c",
    "entries": {
      "rg.exe": {
        "archivePath": "ripgrep-15.2.0-aarch64-pc-windows-msvc/rg.exe",
        "sha256": "d33a29a9ef03c9f4c03be9e8d88498e6e2d2e566d64cdbdef97f9afc8f13120c",
        "maxBytes": 16777216
      },
      "LICENSE-MIT": {
        "archivePath": "ripgrep-15.2.0-aarch64-pc-windows-msvc/LICENSE-MIT",
        "sha256": "970813655a1bf777d2ead189cef71ab73ab92ce04dc864027d61a45de03e6728",
        "maxBytes": 65536
      },
      "UNLICENSE": {
        "archivePath": "ripgrep-15.2.0-aarch64-pc-windows-msvc/UNLICENSE",
        "sha256": "640514163b17f977adc997cb16f51871122cfb0555ebad1a3f01e167b7ba8857",
        "maxBytes": 65536
      }
    }
  },
  "win32-x64": {
    "version": "15.2.0",
    "url": "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-pc-windows-msvc.zip",
    "format": "zip",
    "binaryName": "rg.exe",
    "archiveSha256": "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
    "binarySha256": "14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680",
    "entries": {
      "rg.exe": {
        "archivePath": "ripgrep-15.2.0-x86_64-pc-windows-msvc/rg.exe",
        "sha256": "14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680",
        "maxBytes": 16777216
      },
      "LICENSE-MIT": {
        "archivePath": "ripgrep-15.2.0-x86_64-pc-windows-msvc/LICENSE-MIT",
        "sha256": "970813655a1bf777d2ead189cef71ab73ab92ce04dc864027d61a45de03e6728",
        "maxBytes": 65536
      },
      "UNLICENSE": {
        "archivePath": "ripgrep-15.2.0-x86_64-pc-windows-msvc/UNLICENSE",
        "sha256": "640514163b17f977adc997cb16f51871122cfb0555ebad1a3f01e167b7ba8857",
        "maxBytes": 65536
      }
    }
  }
};
export function rgAsset(platform:NodeJS.Platform=process.platform,arch:string=process.arch):RgAsset|undefined{return RG_ASSETS[`${platform}-${arch}`];}
