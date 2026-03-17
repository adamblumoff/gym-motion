import path from "node:path";

const isWindowsTarget =
  process.platform === "win32" ||
  process.argv.includes("--win") ||
  process.env.npm_lifecycle_event === "build:win";
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
  npmRebuild: false,
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
  extraResources: isWindowsTarget
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
