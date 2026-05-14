const path = require("path");

module.exports = {
  entry: {
    content: "./src/content.ts",
    background: "./src/background.ts",
    popup: "./src/popup.ts",
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js",
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
};
