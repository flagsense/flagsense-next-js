const cloneDeep = require('lodash.clonedeep');
const crossFetch = require('cross-fetch');
const fetchRetry = require('fetch-retry')(crossFetch);
const exitHook = require('async-exit-hook');
const { v4: uuidv4 } = require('uuid');
const Constants = require('../util/constants');
const Utility = require('flagsense-js-client/util/utility');

class Events {
	constructor(headers, environment) {
		this.data = {};
		this.experimentEvents = {};
		this.requestBodyMap = {};
		this.experimentEventsBodyMap = {};
		this.timeSlot = this.getTimeSlot(new Date());
		this.captureEvents = Constants.CAPTURE_EVENTS_FLAG;
		this.captureFlagEvaluations = Constants.CAPTURE_FLAG_EVALUATIONS;

		this.headers = headers;
		this.body = {
			machineId: uuidv4(),
			sdkType: 'next',
			environment: environment,
			data: null,
			time: this.timeSlot
		};

		this.experimentEventsBody = {
			machineId: this.body.machineId,
			sdkType: 'next',
			environment: environment,
			time: this.timeSlot,
			experimentEvents: null
		};

		if (this.captureEvents || this.captureFlagEvaluations) {
			setTimeout(() => {
				this.sendEvents();
			}, Constants.EVENT_FLUSH_INITIAL_DELAY);
		}

		this.registerShutdownHook();
	}

	addEvaluationCount(flagId, variantKey) {
		try {
			if (!this.captureFlagEvaluations)
				return;

			const currentTimeSlot = this.getTimeSlot(new Date());
			if (currentTimeSlot !== this.timeSlot)
				this.checkAndRefreshData(currentTimeSlot);

			if (this.data.hasOwnProperty(flagId)) {
				if (this.data[flagId].hasOwnProperty(variantKey))
					this.data[flagId][variantKey] = this.data[flagId][variantKey] + 1;
				else
					this.data[flagId][variantKey] = 1;
			} else {
				this.data[flagId] = {
					[variantKey]: 1
				};
			}
		}
		catch (err) {
		}
	}

	recordExperimentEvent(flagId, variantKey, eventName, value) {
		try {
			if (!this.captureEvents)
				return;

			const currentTimeSlot = this.getTimeSlot(new Date());
			if (currentTimeSlot !== this.timeSlot)
				this.checkAndRefreshData(currentTimeSlot);

			let metricsMap = {
				count: 1,
				total: value,
				minimum: value,
				maximum: value
			};

			if (this.experimentEvents.hasOwnProperty(flagId)) {
				if (this.experimentEvents[flagId].hasOwnProperty(eventName)) {
					if (this.experimentEvents[flagId][eventName].hasOwnProperty(variantKey)) {
						metricsMap = this.experimentEvents[flagId][eventName][variantKey];
						metricsMap.count = metricsMap.count + 1;
						metricsMap.total = metricsMap.total + value;
						metricsMap.minimum = Math.min(metricsMap.minimum, value);
						metricsMap.maximum = Math.max(metricsMap.maximum, value);
					}
					this.experimentEvents[flagId][eventName][variantKey] = metricsMap;
				} else {
					this.experimentEvents[flagId][eventName] = {
						[variantKey]: metricsMap
					};
				}
			} else {
				this.experimentEvents[flagId] = {
					[eventName]: {
						[variantKey]: metricsMap
					}
				};
			}
		}
		catch (err) {
		}
	}

	setConfig(config) {
		if (!config)
			return;

		if (config.captureDeviceEvents === false || config.captureDeviceEvents === true)
			this.captureDeviceEvents = config.captureDeviceEvents;

		if (config.captureDeviceEvaluations === false || config.captureDeviceEvaluations === true)
			this.captureFlagEvaluations = config.captureDeviceEvaluations;
	}

	checkAndRefreshData(currentTimeSlot) {
		if (currentTimeSlot === this.timeSlot)
			return;
		this.refreshData(currentTimeSlot);
	}

	refreshData(currentTimeSlot) {
		if (this.captureFlagEvaluations && !Utility.isEmpty(this.data)) {
			this.body.time = this.timeSlot;
			this.body.data = this.data;
			this.requestBodyMap[this.timeSlot] = cloneDeep(this.body);
		}

		if (this.captureEvents && !Utility.isEmpty(this.experimentEvents)) {
			this.experimentEventsBody.time = this.timeSlot;
			this.experimentEventsBody.experimentEvents = this.experimentEvents;
			this.experimentEventsBodyMap[this.timeSlot] = cloneDeep(this.experimentEventsBody);
		}

		this.timeSlot = currentTimeSlot;
		this.data = {};
		this.experimentEvents = {};
	}

	getTimeSlot(date) {
		return new Date(Math.ceil(date / Constants.EVENT_FLUSH_INTERVAL) * Constants.EVENT_FLUSH_INTERVAL).getTime();
	}

	registerShutdownHook() {
		exitHook(async (callback) => {
			this.refreshData(this.getTimeSlot(new Date()));
			await this.sendEvents();
			callback();
		});
	}

	async sendEvents() {
		if (!this.captureEvents && !this.captureFlagEvaluations)
			return;

		const currentTimeSlot = this.getTimeSlot(new Date());
		if (currentTimeSlot !== this.timeSlot)
			this.refreshData(currentTimeSlot);

		const asyncTasks = [];
		const timeKeys = Object.keys(this.requestBodyMap);

		for (const time of timeKeys) {
			if (this.requestBodyMap.hasOwnProperty(time)) {
				const requestBody = this.requestBodyMap[time];
				if (requestBody) {
					asyncTasks.push(this.asyncPostRequest('variantsData', requestBody));
					delete this.requestBodyMap[time];
				}
			}
		}

		const experimentEventsTimeKeys = Object.keys(this.experimentEventsBodyMap);
		for (const time of experimentEventsTimeKeys) {
			if (this.experimentEventsBodyMap.hasOwnProperty(time)) {
				const requestBody = this.experimentEventsBodyMap[time];
				if (requestBody) {
					asyncTasks.push(this.asyncPostRequest('experimentEvents', requestBody));
					delete this.experimentEventsBodyMap[time];
				}
			}
		}

		let [err, res] = await Utility.invoke(Promise.all(asyncTasks));
		if (err)
			console.log(err);

		if (this.captureEvents || this.captureFlagEvaluations) {
			setTimeout(() => {
				this.sendEvents();
			}, Constants.EVENT_FLUSH_INTERVAL);
		}
	}

	asyncPostRequest(api, requestBody) {
		return new Promise((resolve, reject) => {
			// console.log("sending events at: " + new Date());
			// console.log(JSON.stringify(requestBody));
			this.postRequest(api, requestBody, (err, res) => {
				if (err)
					console.log(err);
				return resolve(res);
			});
		});
	}

	postRequest(api, body, callback) {
		let options = {
			method: 'POST',
			headers: this.headers,
			body: JSON.stringify(body),
			keepalive: true,
			retryDelay: 5000,
			retryOn: (attempt, err, res) => {
				if (attempt > 4) return false;
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

		fetchRetry(Constants.EVENTS_BASE_URL + api, options)
			.then((res) => {
				if (!res.ok)
					return callback(res.status);
				return callback(null, res.status);
			})
			.catch((err) => {
				return callback(err);
			});
	}
}

module.exports = Events;
