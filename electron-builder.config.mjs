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
