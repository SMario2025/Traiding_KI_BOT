import { getMintMetrics, getMintPriceSeries } from "./live/pumpStream.js";
import {
  deleteRuntimeWatchlist,
  getRuntimeWatchlist,
  getRuntimeWatchlistByMint,
  upsertRuntimeWatchlist,
} from "./db.js";

export type WatchStatus = "WATCH" | "READY" | "COOLDOWN";

export type WatchlistSnapshot = {
  mint: string;
  symbol: string;
  status: WatchStatus;
  score: number;
  aiScore: number;
  bestScore: number;
  seenCount: number;
  stableSeconds: number;
  pullbackFromLocalHighPct: number;
  currentPrice: number;
  change5mPct: number;
  change15mPct: number;
  change1hPct: number;
  summary: string;
  reasons: string[];
  readyToBuy: boolean;
  updatedAt: number;
  entryLabel: string;
  chart: Array<{ ts: number; price: number; pctFromFirst: number }>;
};

export function persistWatchCandidate(params: {
  mint: string;
  symbol: string;
  status: WatchStatus;
  score: number;
  aiScore: number;
  bestScore: number;
  seenCount: number;
  stableSeconds: number;
  pullbackFromLocalHighPct: number;
  summary: string;
  reasons: string[];
  entryLabel: string;
}) {
  const metrics = getMintMetrics(params.mint);
  upsertRuntimeWatchlist({
    mint: params.mint,
    symbol: params.symbol || metrics?.symbol || "PUMP",
    status: params.status,
    score: params.score,
    aiScore: params.aiScore,
    bestScore: params.bestScore,
    seenCount: params.seenCount,
    stableSeconds: params.stableSeconds,
    pullbackFromLocalHighPct: params.pullbackFromLocalHighPct,
    currentPrice: Number(metrics?.currentPrice || 0),
    change5mPct: Number(metrics?.change5mPct || 0),
    change15mPct: Number(metrics?.change15mPct || 0),
    change1hPct: Number(metrics?.change1hPct || 0),
    summary: params.summary,
    reasons: params.reasons,
    readyToBuy: params.status === "READY",
    entryLabel: params.entryLabel,
  });
}

export function removeWatchCandidate(mint: string) {
  deleteRuntimeWatchlist(mint);
}

export function getWatchCandidate(mint: string) {
  return getRuntimeWatchlistByMint(mint);
}

export type WatchlistMovementStats = {
  samples: number;
  freshnessSec: number;
  moveFromFirstPct: number;
  maxUpPct: number;
  drawdownFromHighPct: number;
  volatilityPct: number;
  positiveClose: boolean;
  strongFollowThrough: boolean;
};

function computeMovementStats(mint: string): WatchlistMovementStats {
  const chart = getMintPriceSeries(mint, 60);
  if (!chart.length) {
    return {
      samples: 0,
      freshnessSec: 999999,
      moveFromFirstPct: 0,
      maxUpPct: 0,
      drawdownFromHighPct: 0,
      volatilityPct: 0,
      positiveClose: false,
      strongFollowThrough: false,
    };
  }

  const first = Number(chart[0]?.price || 0);
  const last = Number(chart[chart.length - 1]?.price || 0);
  const highest = Math.max(...chart.map((p) => Number(p.price || 0)));
  const lowest = Math.min(...chart.map((p) => Number(p.price || 0)).filter(Boolean));
  const moveFromFirstPct = first > 0 ? last / first - 1 : 0;
  const maxUpPct = first > 0 ? highest / first - 1 : 0;
  const drawdownFromHighPct = highest > 0 ? last / highest - 1 : 0;
  const volatilityPct = lowest > 0 ? highest / lowest - 1 : 0;
  const freshnessSec = Math.max(0, (Date.now() - Number(chart[chart.length - 1]?.ts || 0)) / 1000);

  return {
    samples: chart.length,
    freshnessSec: Number(freshnessSec.toFixed(1)),
    moveFromFirstPct: Number(moveFromFirstPct.toFixed(4)),
    maxUpPct: Number(maxUpPct.toFixed(4)),
    drawdownFromHighPct: Number(drawdownFromHighPct.toFixed(4)),
    volatilityPct: Number(volatilityPct.toFixed(4)),
    positiveClose: moveFromFirstPct > 0,
    strongFollowThrough: maxUpPct >= 0.05,
  };
}

export function refreshRuntimeWatchlistMetrics(limit = 200) {
  for (const item of getRuntimeWatchlist(limit)) {
    const metrics = getMintMetrics(item.mint);
    if (!metrics) continue;

    upsertRuntimeWatchlist({
      mint: item.mint,
      symbol: item.symbol || metrics.symbol || 'PUMP',
      status: item.status,
      score: Number(item.score || 0),
      aiScore: Number(item.aiScore || 0),
      bestScore: Number(item.bestScore || 0),
      seenCount: Number(item.seenCount || 0),
      stableSeconds: Number(item.stableSeconds || 0),
      pullbackFromLocalHighPct: Number(item.pullbackFromLocalHighPct || 0),
      currentPrice: Number(metrics.currentPrice || item.currentPrice || 0),
      change5mPct: Number(metrics.change5mPct || 0),
      change15mPct: Number(metrics.change15mPct || 0),
      change1hPct: Number(metrics.change1hPct || 0),
      summary: item.summary,
      reasons: item.reasons || [],
      readyToBuy: Boolean(item.readyToBuy),
      entryLabel: item.entryLabel,
    });
  }
}

export function getWatchlistLearningSnapshots(limit = 120) {
  return getRuntimeWatchlist(limit).map((item) => ({
    ...item,
    chart: getMintPriceSeries(item.mint, 60),
    movement: computeMovementStats(item.mint),
  }));
}

export function getWatchlistSnapshots(limit = 24): WatchlistSnapshot[] {
  return getRuntimeWatchlist(limit).map((item) => ({
    ...item,
    chart: getMintPriceSeries(item.mint, 36),
  }));
}
