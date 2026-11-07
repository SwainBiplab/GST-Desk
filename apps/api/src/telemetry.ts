/**
 * OpenTelemetry traces and metrics to the collector named by OTEL_EXPORTER_OTLP_ENDPOINT; a no-op when
 * it is not set. The request middleware comes from `@hono/otel`; the metrics here are the ones the
 * dashboards in `infra/grafana` draw.
 */
import { metrics, type Histogram, type ObservableGauge } from '@opentelemetry/api';
import type { Logger } from 'pino';

import type { Config } from './config';

export interface Telemetry {
  requestDuration: Histogram;
  queueDepth: ObservableGauge;
  stop(): Promise<void>;
}

export async function startTelemetry(config: Config, log: Logger): Promise<Telemetry> {
  let sdk: { shutdown(): Promise<void> } | null = null;
  if (config.otelEndpoint) {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http');
    const { PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics');
    const node = new NodeSDK({
      serviceName: 'gst-api',
      traceExporter: new OTLPTraceExporter({ url: `${config.otelEndpoint}/v1/traces` }),
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${config.otelEndpoint}/v1/metrics` }),
          exportIntervalMillis: 15_000,
        }),
      ],
    });
    node.start();
    sdk = node;
    log.info({ endpoint: config.otelEndpoint }, 'telemetry on');
  }
  const meter = metrics.getMeter('gst-api');
  return {
    requestDuration: meter.createHistogram('http.server.request.duration', {
      unit: 'ms',
      description: 'Request duration by route and status',
    }),
    queueDepth: meter.createObservableGauge('jobs.queue.depth', {
      description: 'Waiting jobs per queue',
    }),
    stop: async () => {
      await sdk?.shutdown();
    },
  };
}
