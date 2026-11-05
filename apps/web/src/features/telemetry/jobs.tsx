import { useEffect } from 'react';

import { sendIfDue, track } from './telemetry';

/** Counts that the app was opened, and sends the weekly counters if the person opted in and there is somewhere to send them. */
export function TelemetryJobs() {
  useEffect(() => {
    track('app_opened');
    const first = setTimeout(() => void sendIfDue(), 20_000);
    const every = setInterval(() => void sendIfDue(), 3_600_000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, []);
  return null;
}
