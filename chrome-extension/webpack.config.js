const path    = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');
const HtmlPlugin = require('html-webpack-plugin');
require('dotenv').config({ path: '../.env' });

const BACKEND_URL   = process.env.BACKEND_URL   || 'https://classguard.example.org';
const GOOGLE_CLIENT = process.env.GOOGLE_CLIENT_ID || '';

// ---------------------------------------------------------------------------
// Shared define plugin — injects config into all bundles at build time
// ---------------------------------------------------------------------------
const define = new webpack.DefinePlugin({
  __BACKEND_URL__:      JSON.stringify(BACKEND_URL),
  __GOOGLE_CLIENT_ID__: JSON.stringify(GOOGLE_CLIENT),
  'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
});

// ---------------------------------------------------------------------------
// Config 1: Service worker  (target: webworker — no DOM)
// ---------------------------------------------------------------------------
const swConfig = {
  name:   'service-worker',
  target: 'webworker',
  entry:  './src/background/service-worker.js',
  output: {
    path:     path.resolve(__dirname, 'dist'),
    filename: 'service-worker.bundle.js',
  },
  resolve: {
    fallback: {
      // socket.io-client pulls these in; stub them for the webworker target
      fs:   false,
      net:  false,
      tls:  false,
      path: false,
    },
  },
  module: {
    rules: [{
      test: /\.js$/,
      use:  'babel-loader',
      exclude: /node_modules/,
    }],
  },
  plugins: [define],
};

// ---------------------------------------------------------------------------
// Config 2: Pages + content script  (target: web — has DOM)
// ---------------------------------------------------------------------------
const webConfig = {
  name:   'web',
  target: 'web',
  entry: {
    popup:            './src/pages/popup.js',
    blocked:          './src/pages/blocked.js',
    'content-script': './src/content/content-script.js',
  },
  output: {
    path:     path.resolve(__dirname, 'dist'),
    filename: '[name].bundle.js',
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        use:  'babel-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use:  ['style-loader', 'css-loader'],
      },
    ],
  },
  plugins: [
    define,
    new HtmlPlugin({
      template: './src/pages/popup.html',
      filename: 'popup.html',
      chunks:   ['popup'],
      inject:   'body',
    }),
    new HtmlPlugin({
      template: './src/pages/blocked.html',
      filename: 'blocked.html',
      chunks:   ['blocked'],
      inject:   'body',
    }),
    new CopyPlugin({
      patterns: [
        // Transform manifest: inject build-time values
        {
          from: 'src/manifest.json',
          to:   'manifest.json',
          transform: (content) => {
            const manifest = JSON.parse(content.toString());
            manifest.version            = require('./package.json').version;
            manifest.oauth2.client_id   = GOOGLE_CLIENT;
            return JSON.stringify(manifest, null, 2);
          },
        },
        // Icons — place PNG files in src/icons/ before building
        {
          from:    'src/icons',
          to:      'icons',
          noErrorOnMissing: true,
        },
      ],
    }),
  ],
};

module.exports = [swConfig, webConfig];
