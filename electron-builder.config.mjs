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
    "desktop/resources/**",
    "out/**",
    "package.json",
  ],
  directories: {
    buildResources: "desktop/resources",
    output: "release",
  },
  win: {
    icon: "desktop/resources/icon.ico",
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
