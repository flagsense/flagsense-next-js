const crossFetch = require('cross-fetch');
const fetchRetry = require('fetch-retry')(crossFetch);
const Utility = require('flagsense-js-client/util/utility');
const Constants = require('flagsense-js-client/util/constants');
const FlagsenseError = require('flagsense-js-client/util/flagsense-error');
const FSVariation = require('flagsense-js-client/model/FSVariation');
const UserVariant = require('flagsense-js-client/services/user-variant');
const DeviceEvents = require('flagsense-js-client/services/device-events');
const FSUser = require('flagsense-js-client/model/FSUser');
const Events = require('./events');

class Flagsense {
	constructor(sdkId, sdkSecret, environment) {
		if (!sdkId || !sdkSecret)
			throw new FlagsenseError('Empty sdk params not allowed');

		this.lastUpdatedOn = 0;
		this.lastSuccessfulCallOn = 0;
		this.environment = environment;
		if (!environment || Constants.ENVIRONMENTS.indexOf(environment) === -1)
			this.environment = 'PROD';

		this.headers = {
			'Accept': 'application/json',
			'Content-Type': 'application/json'
		};
		this.headers[Constants.HEADERS.AUTH_TYPE] = 'fsdk';
		this.headers[Constants.HEADERS.SDK_ID] = sdkId;
		this.headers[Constants.HEADERS.SDK_SECRET] = sdkSecret;
		this.maxInitializationWaitTime = Constants.MAX_INITIALIZATION_WAIT_TIME;

		this.data = {
			segments: null,
			flags: null,
			experiments: null
		};

		this.userVariant = new UserVariant(this.data);
		if (Utility.isBrowser())
			this.deviceEvents = new DeviceEvents(this.headers, this.environment);
		if (Utility.isServer())
			this.events = new Events(this.headers, this.environment);

		this.fetchLatest();
		this.listeners();
	}

	initializationComplete() {
		return this.lastUpdatedOn > 0 || !Utility.isInternetConnected();
	}

	// Returns a promise which is resolved after the initialization is complete
	waitForInitializationComplete() {
		return Utility.waitFor(this.initializationComplete.bind(this), this.maxInitializationWaitTime);
	}

	async waitForInitializationCompleteAsync() {
		await Utility.invoke(
			Utility.waitFor(this.initializationComplete.bind(this), this.maxInitializationWaitTime)
		);
	}

	setFSUser(fsUser) {
		if (this.deviceEvents && fsUser)
			this.deviceEvents.setFSUser(fsUser);
	}

	setDeviceInfo(deviceInfo) {
		if (this.deviceEvents)
			this.deviceEvents.setDeviceInfo(deviceInfo);
	}

	setAppInfo(appInfo) {
		if (this.deviceEvents)
			this.deviceEvents.setAppInfo(appInfo);
	}

	setMaxInitializationWaitTime(timeInMillis) {
		this.maxInitializationWaitTime = timeInMillis;
	}

	getVariation(fsFlag, fsUser) {
		if (!fsUser) fsUser = new FSUser();
		this.setFSUser(fsUser);

		const variant = this.getVariant(fsFlag.flagId, fsUser.userId, fsUser.attributes, {
			key: fsFlag.defaultKey,
			value: fsFlag.defaultValue
		});
		return new FSVariation(variant.key, variant.value);
	}

	recordEvent(fsFlag, fsUser, eventName, value, eventType, eventAttributes) {
		if (!fsFlag || !fsUser || !eventName || this.lastUpdatedOn === 0)
			return;
		this.setFSUser(fsUser);
		if (value === undefined)
			value = 1;

		const experiment = this.data.experiments[fsFlag.flagId];
		if (!experiment || !experiment.eventNames || experiment.eventNames.indexOf(eventName) === -1)
			return;

		const variantKey = this.getVariantKey(fsUser, fsFlag.flagId, fsFlag.defaultKey);
		if (fsFlag.flagId && variantKey) {
			if (this.deviceEvents)
				this.deviceEvents.recordExperimentEvent(fsFlag.flagId, variantKey, eventName,
					value, eventType, eventAttributes);
			if (this.events)
				this.events.recordExperimentEvent(fsFlag.flagId, variantKey, eventName, value);
		}
	}

	getVariant(flagId, userId, attributes, defaultVariant) {
		try {
			if (this.lastUpdatedOn === 0)
				throw new FlagsenseError('Loading data');
			const variant = this.userVariant.evaluate(userId, attributes, flagId);
			if (this.deviceEvents)
				this.deviceEvents.addEvaluationCount(flagId, variant.key);
			if (this.events)
				this.events.addEvaluationCount(flagId, variant.key);
			return variant;
		}
		catch (err) {
			// console.error(err);
			const variantKey = (defaultVariant && defaultVariant.key) ? defaultVariant.key : 'FS_Empty';
			if (this.deviceEvents)
				this.deviceEvents.addEvaluationCount(flagId, variantKey);
			if (this.events)
				this.events.addEvaluationCount(flagId, variantKey);
			return defaultVariant;
		}
	}

	getVariantKey(fsUser, flagId, defaultVariantKey) {
		try {
			if (this.lastUpdatedOn === 0)
				throw new FlagsenseError('Loading data');
			return this.userVariant.evaluate(fsUser.userId, fsUser.attributes, flagId).key;
		}
		catch (err) {
			return defaultVariantKey || 'FS_Empty';
		}
	}

	listeners() {
		if (Utility.isServer()) {
			const data_refresh_interval = 60 * 1000;
			setInterval(this.fetchLatest.bind(this), data_refresh_interval);
		}
		else {
			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'visible') {
					this.fetchLatest();
				}
			});

			if (Utility.isSafari()) {
				document.addEventListener('pageshow', (event) => {
					this.fetchLatest();
				});
			}

			window.addEventListener('online', () => {
				this.fetchLatest();
			});
		}
	}

	fetchLatest() {
		if (this.lastUpdatedOn > 0 && Utility.isBrowser() &&
			(new Date()).getTime() - this.lastSuccessfulCallOn < Constants.DATA_REFRESH_INTERVAL)
			return;

		// console.log(this.lastUpdatedOn, this.lastSuccessfulCallOn, "fetching data at: " + new Date());
		const api = this.headers[Constants.HEADERS.SDK_ID] + '/' + this.environment;

		this.getRequest(api, (err, res) => {
			if (err)
				console.log(err);

			if (err || !res)
				return;

			this.lastSuccessfulCallOn = (new Date()).getTime();
			if (res.lastUpdatedOn && res.segments && res.flags && res.experiments) {
				if (!Utility.isEmpty(res.segments))
					this.data.segments = res.segments;
				if (!Utility.isEmpty(res.flags))
					this.data.flags = res.flags;
				if (!Utility.isEmpty(res.experiments))
					this.data.experiments = res.experiments;
				this.lastUpdatedOn = res.lastUpdatedOn;
			}
			if (res.config && this.deviceEvents) {
				if (this.deviceEvents)
					this.deviceEvents.setConfig(res.config);
				if (this.events)
					this.events.setConfig(res.config);
			}
		});
	}

	getRequest(api, callback) {
		let options = {
			headers: this.headers,
			retryDelay: 2000,
			retryOn: (attempt, err, res) => {
				if (attempt > 3) return false;
				if (err) return true;
				if (res.status < 500 || res.status >= 600) {
					switch (res.status) {
						case 205:
						case 408:
						case 422:
						case 429:
							return true;
						default:
							return false;
					}
				}
				return true;
			}
		};

		fetchRetry(Constants.BASE_URL + api, options)
			.then((res) => {
				if (!res.ok)
					return callback(res.status);
				return res.json();
			})
			.then((jsonRes) => {
				return callback(null, jsonRes);
			})
			.catch((err) => {
				return callback(err);
			});
	}
}

module.exports = Flagsense;
