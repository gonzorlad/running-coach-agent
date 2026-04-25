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

  if (distanceKm >= 7) return 'long';
  if (paceMinPerKm < 5.0) return 'intervals';
  if (paceMinPerKm < 6) return 'tempo';
  return 'easy';
}

export const getTrainingLoadTool = createTool({
  id: 'get-training-load',
  description: 'Calculates training load, volume trends, and recovery signals from real Strava data. Use when asked about overtraining, fatigue, weekly mileage trends, or whether training load is too high or too low.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    this_week: z.object({
      runs: z.number(),
      total_km: z.number(),
      avg_heart_rate: z.number(),
      hard_sessions: z.number(),
      run_types: z.record(z.string(), z.number()),
    }),
    last_week: z.object({
      runs: z.number(),
      total_km: z.number(),
    }),
    week_on_week_km_change_pct: z.number(),
    days_since_last_run: z.number(),
    last_run_type: z.string(),
  }),
  execute: async () => {
    const token = await getValidAccessToken();

    const response = await fetch(
      'https://www.strava.com/api/v3/athlete/activities?per_page=30&page=1',
      { headers: { 'Authorization': `Bearer ${token}` } }
    );

    const activities = await response.json();

    const runs = activities
      .filter((a: any) => a.type === 'Run' || a.sport_type === 'Run')
      .map((a: any) => ({
        date: new Date(a.start_date_local),
        distance_km: Math.round(a.distance / 100) / 10,
        avg_heart_rate: a.average_heartrate || 0,
        run_type: classifyRunType(
          Math.round(a.distance / 100) / 10,
          a.average_speed
        ),
      }));

    const now = new Date();
    const startOfThisWeek = new Date(now);
    startOfThisWeek.setDate(now.getDate() - now.getDay());
    startOfThisWeek.setHours(0, 0, 0, 0);

    const startOfLastWeek = new Date(startOfThisWeek);
    startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);

    const thisWeekRuns = runs.filter((r: any) => r.date >= startOfThisWeek);
    const lastWeekRuns = runs.filter((r: any) => r.date >= startOfLastWeek && r.date < startOfThisWeek);

    const totalKmThis = Math.round(thisWeekRuns.reduce((sum: number, r: any) => sum + r.distance_km, 0) * 10) / 10;
    const totalKmLast = Math.round(lastWeekRuns.reduce((sum: number, r: any) => sum + r.distance_km, 0) * 10) / 10;

    const avgHR = thisWeekRuns.length
      ? Math.round(thisWeekRuns.reduce((sum: number, r: any) => sum + r.avg_heart_rate, 0) / thisWeekRuns.length)
      : 0;

    const hardSessions = thisWeekRuns.filter((r: any) => r.run_type === 'intervals' || r.run_type === 'tempo').length;

    const runTypes: Record<string, number> = {};
    thisWeekRuns.forEach((r: any) => {
      runTypes[r.run_type] = (runTypes[r.run_type] || 0) + 1;
    });

    const weekOnWeekChange = totalKmLast > 0
      ? Math.round(((totalKmThis - totalKmLast) / totalKmLast) * 100)
      : 0;

    const sortedRuns = [...runs].sort((a: any, b: any) => b.date - a.date);
    const lastRun = sortedRuns[0];
    const daysSinceLastRun = lastRun
      ? Math.floor((now.getTime() - lastRun.date.getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    return {
      this_week: {
        runs: thisWeekRuns.length,
        total_km: totalKmThis,
        avg_heart_rate: avgHR,
        hard_sessions: hardSessions,
        run_types: runTypes,
      },
      last_week: {
        runs: lastWeekRuns.length,
        total_km: totalKmLast,
      },
      week_on_week_km_change_pct: weekOnWeekChange,
      days_since_last_run: daysSinceLastRun,
      last_run_type: lastRun?.run_type || 'unknown',
    };
  },
});