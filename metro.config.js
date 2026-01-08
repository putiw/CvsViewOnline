const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

// Add nii and gz to asset extensions
config.resolver.assetExts.push('nii', 'gz');

module.exports = withNativeWind(config, { input: './global.css' });
