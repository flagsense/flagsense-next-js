require('es6-promise').polyfill();
const FlagsenseService = require('./services/flagsense');
const FSFlag = require("flagsense-js-client/model/FSFlag");
const FSUser = require("flagsense-js-client/model/FSUser");

const flagsenseServiceMap = {};

exports.createService = function (sdkId, sdkSecret, environment) {
	if (!flagsenseServiceMap.hasOwnProperty(sdkId))
		flagsenseServiceMap[sdkId] = new FlagsenseService(sdkId, sdkSecret, environment);
	return flagsenseServiceMap[sdkId];
}

exports.flag = function (flagId, defaultKey, defaultValue) {
	return new FSFlag(flagId, defaultKey, defaultValue);
}

exports.user = function (userId, attributes) {
	return new FSUser(userId, attributes);
}

// Below methods can be used on instance returned from createService method
// initializationComplete()
// waitForInitializationComplete()
// waitForInitializationCompleteAsync()
// getVariation(fsFlag, fsUser)
// recordEvent(fsFlag, fsUser, eventName, value)
// setMaxInitializationWaitTime(timeInMillis)
