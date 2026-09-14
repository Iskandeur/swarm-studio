/** Domain model for a swarm: who the agents are, and who is allowed to speak to whom. */

export type ProviderId = 'mock' | 'openai' | 'anthropic' | 'openrouter'

/** How a speaking turn is handed to the agents an agent points at. */
export type Topology =
  /** Every outgoing link carries the message. The swarm widens each round. */
  | 'broadcast'
  /** One outgoing link per turn, rotating. The swarm stays narrow and walks. */
  | 'round-robin'
  /** Workers answer, then the entry agent speaks again with every reply in hand. */
  | 'manager'

export interface Agent {
  id: string
  name: string
  provider: ProviderId
  model: string
  systemPrompt: string
  temperature: number
  /** Hue (0-360) used everywhere this agent shows up: node, edge, transcript. */
  hue: number
  position: { x: number; y: number }
}

export interface Link {
  id: string
  source: string
  target: string
}

export interface SwarmSpec {
  name: string
  task: string
  agents: Agent[]
  links: Link[]
  topology: Topology
  maxRounds: number
  /** Agents that receive the task. Empty means "every agent with no incoming link". */
  entryIds: string[]
}

export type AgentStatus = 'idle' | 'queued' | 'thinking' | 'speaking' | 'done' | 'error'

export interface TranscriptEntry {
  id: string
  round: number
  agentId: string
  /** Agent ids this message was handed to. Empty for a leaf. */
  to: string[]
  text: string
  status: 'streaming' | 'complete' | 'error'
  tokensIn: number
  tokensOut: number
  startedAt: number
  endedAt?: number
}

export type RunPhase = 'idle' | 'running' | 'paused' | 'done' | 'error' | 'stopped'
