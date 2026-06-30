const platformConfigService = require("../platformConfig.service");

async function getAppConfig() {
  return platformConfigService.getAdminAppConfig();
}

async function presignSplashUpload(contentType) {
  return platformConfigService.presignSplashUpload(contentType);
}

async function updateAppConfig(body = {}) {
  if (body.splashBackgroundS3Key === null) {
    return platformConfigService.clearSplashBackground();
  }
  return platformConfigService.updateSplashBackground(body.splashBackgroundS3Key);
}

module.exports = {
  getAppConfig,
  presignSplashUpload,
  updateAppConfig,
};
