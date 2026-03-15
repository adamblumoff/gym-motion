import path from "node:path";

const isWindows = process.platform === "win32";
const sidecarPath = path.join(
  process.cwd(),
  "native",
  "windows-ble-sidecar",
  "target",
  "release",
  "gym-motion-ble-winrt.exe",
);

export default {
  appId: "com.gymmotion.desktop",
  productName: "Gym Motion",
  asar: true,
  asarUnpack: [
    "backend/runtime/**",
    "desktop/scripts/**",
  ],
  files: [
    "backend/runtime/**",
    "dist/**",
    "out/**",
    "desktop/scripts/**",
    "package.json",
  ],
  extraResources: isWindows
    ? [
        {
          from: sidecarPath,
          to: "bin/gym-motion-ble-winrt.exe",
        },
      ]
    : [],
  directories: {
    output: "release",
  },
  win: {
    target: [
      {
        target: "nsis",
        arch: ["arm64"],
      },
      {
        target: "portable",
        arch: ["arm64"],
      },
    ],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
};
