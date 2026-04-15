import path from "node:path";

const isWindowsTarget =
  process.platform === "win32" ||
  process.argv.includes("--win") ||
  process.env.npm_lifecycle_event === "build:win";
const sidecarImplementation =
  process.env.GYM_MOTION_WINDOWS_SIDECAR_IMPL === "rust" ? "rust" : "dotnet";
const sidecarPath = path.join(
  process.cwd(),
  "native",
  sidecarImplementation === "rust" ? "windows-ble-sidecar" : "windows-dotnet-ble-sidecar",
  ...(sidecarImplementation === "rust"
    ? ["target", "release"]
    : ["bin", "Release", "net9.0-windows10.0.19041.0", "publish"]),
  "gym-motion-ble-winrt.exe",
);

export default {
  appId: "com.gymmotion.desktop",
  productName: "Gym Motion",
  npmRebuild: false,
  asar: true,
  asarUnpack: [
    "out/runtime/**",
  ],
  files: [
    "dist/**",
    "out/**",
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
