// ---------------------------------------------------------------
// Counts security events as CloudWatch metrics in the namespace OKR18/Auth,
// so an alarm can fire on a burst of failed logins (threat T1).
// A metric must never break a login: errors are logged, not thrown.
// ---------------------------------------------------------------
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');

function createMetrics({ client } = {}) {
    const cw = client || new CloudWatchClient({});
    return {
        count(name) {
            cw.send(new PutMetricDataCommand({
                Namespace: 'OKR18/Auth',
                MetricData: [{ MetricName: name, Value: 1, Unit: 'Count' }]
            })).catch((error) => console.error(JSON.stringify({ service: 'auth', metricFailed: name, error: error.name })));
        }
    };
}

module.exports = { createMetrics };
