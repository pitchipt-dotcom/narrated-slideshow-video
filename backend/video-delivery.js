"use strict";

const { resolveManualVideo } = require("./manual-job-status");

// Resolves the finished MP4 of a job for the /video/job/<id>/(view|download) routes.
function resolveDeliveredVideo(options, jobId) {
  return resolveManualVideo(options.manualRoot, jobId);
}

module.exports = { resolveDeliveredVideo };
