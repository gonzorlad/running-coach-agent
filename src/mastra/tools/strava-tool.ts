import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

async function getValidAccessToken(): Promise<string> {
  const expiresAt = parseInt(process.env.STRAVA_TOKEN_EXPIRES_AT || '0');
  const now = Math.floor(Date.now() / 1000);

  if (now < expiresAt - 60) {
    return process.env.STRAVA_ACCESS_TOKEN!;
  }

  const response = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: process.env.STRAVA_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  const data = await response.json();
  process.env.STRAVA_ACCESS_TOKEN = data.access_token;
  process.env.STRAVA_REFRESH_TOKEN = data.refresh_token;
  process.env.STRAVA_TOKEN_EXPIRES_AT = data.expires_at.toString();

  return data.access_token;
}

function classifyRunType(distanceKm: number, avgSpeedMs: number): string {
  const paceSecondsPerKm = 1000 / avgSpeedMs;
  const paceMinPerKm = paceSecondsPerKm / 60;

  if (distanceKm >= 15) return 'long';
  if (paceMinPerKm < 5.0) return 'intervals';
  if (paceMinPerKm < 5.45) return 'tempo';
  return 'easy';
}

export const getStravaRunsTool = createTool({
  id: 'get-strava-runs',
  description: 'Fetches Keith\'s real running data from Strava/Garmin. Use this when asked about runs, pace, heart rate, mileage, or run history.',
  inputSchema: z.object({
    limit: z.number().optional().describe('Number of recent runs to fetch. Defaults to 10.'),
  }),
  outputSchema: z.array(z.object({
    id: z.number(),
    name: z.string(),
    date: z.string(),
    distance_km: z.number(),
    duration_minutes: z.number(),
    avg_pace_per_km: z.string(),
    avg_heart_rate: z.number().nullable(),
    max_heart_rate: z.number().nullable(),
    elevation_gain_m: z.number(),
    run_type: z.string(),
  })),
  execute: async ({ limit }) => {
    const token = await getValidAccessToken();
    const perPage = limit ?? 10;

    const response = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?per_page=${perPage * 2}&page=1`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );

    const activities = await response.json();

    const runs = activities
      .filter((a: any) => a.type === 'Run' || a.sport_type === 'Run')
      .slice(0, perPage)
      .map((a: any) => {
        const distanceKm = Math.round(a.distance / 100) / 10;
        const durationMinutes = Math.round(a.moving_time / 60);
        const paceSecondsPerKm = distanceKm > 0 ? (a.moving_time / distanceKm) : 0;
        const paceMinutes = Math.floor(paceSecondsPerKm / 60);
        const paceSeconds = Math.round(paceSecondsPerKm % 60).toString().padStart(2, '0');

        return {
          id: a.id,
          name: a.name,
          date: a.start_date_local.split('T')[0],
          distance_km: distanceKm,
          duration_minutes: durationMinutes,
          avg_pace_per_km: `${paceMinutes}:${paceSeconds}`,
          avg_heart_rate: a.average_heartrate || null,
          max_heart_rate: a.max_heartrate || null,
          elevation_gain_m: Math.round(a.total_elevation_gain),
          run_type: classifyRunType(distanceKm, a.average_speed),
        };
      });

    return runs;
  },
});