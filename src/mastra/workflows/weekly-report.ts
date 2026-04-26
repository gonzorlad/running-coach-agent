import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

const fetchRunsStep = createStep({
  id: 'fetch-runs',
  description: 'Fetches recent runs from Strava',
  inputSchema: z.object({}),
  outputSchema: z.object({
    runs: z.array(z.object({
      name: z.string(),
      date: z.string(),
      distance_km: z.number(),
      duration_minutes: z.number(),
      avg_pace_per_km: z.string(),
      avg_heart_rate: z.number().nullable(),
      run_type: z.string(),
      elevation_gain_m: z.number(),
    })),
  }),
  execute: async () => {
    const expiresAt = parseInt(process.env.STRAVA_TOKEN_EXPIRES_AT || '0');
    const now = Math.floor(Date.now() / 1000);
    let token = process.env.STRAVA_ACCESS_TOKEN!;

    if (now >= expiresAt - 60) {
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
      token = data.access_token;
      process.env.STRAVA_ACCESS_TOKEN = data.access_token;
      process.env.STRAVA_REFRESH_TOKEN = data.refresh_token;
      process.env.STRAVA_TOKEN_EXPIRES_AT = data.expires_at.toString();
    }

    const response = await fetch(
      'https://www.strava.com/api/v3/athlete/activities?per_page=20&page=1',
      { headers: { 'Authorization': `Bearer ${token}` } }
    );

    const activities = await response.json();

    // Get runs from the last 7 days only
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const runs = activities
      .filter((a: any) => {
        const isRun = a.type === 'Run' || a.sport_type === 'Run';
        const isRecent = new Date(a.start_date_local) >= sevenDaysAgo;
        return isRun && isRecent;
      })
      .map((a: any) => {
        const distanceKm = Math.round(a.distance / 100) / 10;
        const durationMinutes = Math.round(a.moving_time / 60);
        const paceSecondsPerKm = distanceKm > 0 ? (a.moving_time / distanceKm) : 0;
        const paceMinutes = Math.floor(paceSecondsPerKm / 60);
        const paceSeconds = Math.round(paceSecondsPerKm % 60).toString().padStart(2, '0');
        const paceMinPerKm = paceSecondsPerKm / 60;

        let runType = 'easy';
        if (distanceKm >= 15) runType = 'long';
        else if (paceMinPerKm < 5.0) runType = 'intervals';
        else if (paceMinPerKm < 5.45) runType = 'tempo';

        return {
          name: a.name,
          date: a.start_date_local.split('T')[0],
          distance_km: distanceKm,
          duration_minutes: durationMinutes,
          avg_pace_per_km: `${paceMinutes}:${paceSeconds}`,
          avg_heart_rate: a.average_heartrate || null,
          run_type: runType,
          elevation_gain_m: Math.round(a.total_elevation_gain),
        };
      });

    return { runs };
  },
});

const generateReportStep = createStep({
  id: 'generate-report',
  description: 'Generates a weekly coaching report from the run data',
  inputSchema: z.object({
    runs: z.array(z.object({
      name: z.string(),
      date: z.string(),
      distance_km: z.number(),
      duration_minutes: z.number(),
      avg_pace_per_km: z.string(),
      avg_heart_rate: z.number().nullable(),
      run_type: z.string(),
      elevation_gain_m: z.number(),
    })),
  }),
  outputSchema: z.object({
    report: z.string(),
  }),
  execute: async ({ inputData }) => {
    const { runs } = inputData;

    if (runs.length === 0) {
      return { report: "No runs recorded in the last 7 days." };
    }

    const totalKm = runs.reduce((sum, r) => sum + r.distance_km, 0);
    const avgHR = runs
      .filter(r => r.avg_heart_rate)
      .reduce((sum, r) => sum + (r.avg_heart_rate || 0), 0) / runs.filter(r => r.avg_heart_rate).length;

    const runSummary = runs.map(r =>
      `- ${r.date}: ${r.run_type} run, ${r.distance_km}km @ ${r.avg_pace_per_km}/km, HR ${r.avg_heart_rate || 'N/A'}`
    ).join('\n');

    const prompt = `You are a running coach writing a weekly training summary for Keith, a 36 year old hybrid athlete in Berlin who runs 2-3x per week.

Here is his training data for the past 7 days:

${runSummary}

Total: ${runs.length} runs, ${Math.round(totalKm * 10) / 10}km, avg HR ${Math.round(avgHR || 0)}bpm

Write a concise weekly coaching report with:
1. A one-line verdict on the week
2. What went well
3. One thing to focus on next week
4. A specific recommendation for the next session

Be direct. No fluff. Treat him like an athlete.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    const report = data.content[0].text;

    return { report };
  },
});

export const weeklyReportWorkflow = createWorkflow({
  id: 'weekly-report',
  inputSchema: z.object({}),
  outputSchema: z.object({
    report: z.string(),
  }),
})
  .then(fetchRunsStep)
  .then(generateReportStep)
  .commit();