/**
 * A very small, safe renderer for the markdown-ish text models actually produce.
 *
 * Why not a markdown library: the transcript needs six things — paragraphs, bullets, numbered
 * lists, fenced code, inline code and emphasis — and it needs to render *while streaming*, on
 * half-written text. This is ~100 lines, has no dependency, and builds React elements, so there is
 * no HTML injection path at all. The parser is pure and tested.
 */
import { Box, Typography } from '@mui/material'

export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }

export type Block =
  | { kind: 'paragraph'; inlines: InlineToken[] }
  | { kind: 'heading'; level: number; inlines: InlineToken[] }
  | { kind: 'quote'; inlines: InlineToken[] }
  | { kind: 'list'; ordered: boolean; items: InlineToken[][] }
  | { kind: 'code'; language: string; text: string }

/**
 * Splits inline emphasis. Order matters: code spans win over emphasis, because `**` inside a code
 * span is literal — getting that backwards is how a renderer mangles a regex someone pasted.
 */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last) tokens.push({ kind: 'text', text: text.slice(last, index) })
    const raw = match[0]
    if (raw.startsWith('`')) tokens.push({ kind: 'code', text: raw.slice(1, -1) })
    else if (raw.startsWith('**')) tokens.push({ kind: 'bold', text: raw.slice(2, -2) })
    else tokens.push({ kind: 'italic', text: raw.slice(1, -1) })
    last = index + raw.length
  }
  if (last < text.length) tokens.push({ kind: 'text', text: text.slice(last) })
  return tokens.length > 0 ? tokens : [{ kind: 'text', text }]
}

const BULLET = /^\s*[-*•]\s+(.*)$/
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/
const HEADING = /^(#{1,4})\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
const FENCE = /^```\s*([\w+-]*)\s*$/

/**
 * Groups lines into blocks. Tolerant by design: an unclosed code fence still renders as code,
 * because during streaming that is the normal state of the text, not an error.
 */
export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', inlines: parseInline(paragraph.join(' ').trim()) })
    paragraph = []
  }
  const flushList = () => {
    if (!list) return
    blocks.push({ kind: 'list', ordered: list.ordered, items: list.items.map(parseInline) })
    list = null
  }
  const flushAll = () => {
    flushParagraph()
    flushList()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = FENCE.exec(line)
    if (fence) {
      flushAll()
      const language = fence[1] ?? ''
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++])
      blocks.push({ kind: 'code', language, text: body.join('\n') })
      continue
    }

    if (line.trim() === '') {
      flushAll()
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flushAll()
      blocks.push({ kind: 'heading', level: heading[1].length, inlines: parseInline(heading[2]) })
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote) {
      flushAll()
      blocks.push({ kind: 'quote', inlines: parseInline(quote[1]) })
      continue
    }

    const bullet = BULLET.exec(line)
    if (bullet) {
      flushParagraph()
      if (!list || list.ordered) {
        flushList()
        list = { ordered: false, items: [] }
      }
      list.items.push(bullet[1])
      continue
    }

    const ordered = ORDERED.exec(line)
    if (ordered) {
      flushParagraph()
      if (!list || !list.ordered) {
        flushList()
        list = { ordered: true, items: [] }
      }
      list.items.push(ordered[2])
      continue
    }

    flushList()
    paragraph.push(line)
  }
  flushAll()
  return blocks
}

function Inlines({ tokens }: { tokens: InlineToken[] }) {
  return (
    <>
      {tokens.map((token, index) => {
        if (token.kind === 'code') {
          return (
            <Box
              key={index}
              component="code"
              sx={{
                fontFamily: '"Roboto Mono", monospace',
                fontSize: '0.87em',
                px: 0.5,
                py: 0.15,
                borderRadius: 0.75,
                bgcolor: 'action.hover',
              }}
            >
              {token.text}
            </Box>
          )
        }
        if (token.kind === 'bold') return <strong key={index}>{token.text}</strong>
        if (token.kind === 'italic') return <em key={index}>{token.text}</em>
        return <span key={index}>{token.text}</span>
      })}
    </>
  )
}

export function RichText({ source }: { source: string }) {
  const blocks = parseBlocks(source)
  return (
    <Box sx={{ '& > *:first-of-type': { mt: 0 }, '& > *:last-child': { mb: 0 } }}>
      {blocks.map((block, index) => {
        if (block.kind === 'code') {
          return (
            <Box
              key={index}
              component="pre"
              sx={{
                my: 1,
                p: 1.25,
                borderRadius: 1.5,
                bgcolor: 'action.hover',
                border: '1px solid',
                borderColor: 'divider',
                fontFamily: '"Roboto Mono", monospace',
                fontSize: 12,
                lineHeight: 1.55,
                overflowX: 'auto',
              }}
            >
              {block.text}
            </Box>
          )
        }
        if (block.kind === 'heading') {
          return (
            <Typography
              key={index}
              variant="subtitle2"
              sx={{ mt: 1.25, mb: 0.5, fontSize: block.level <= 2 ? 14 : 13, fontWeight: 600 }}
            >
              <Inlines tokens={block.inlines} />
            </Typography>
          )
        }
        if (block.kind === 'quote') {
          return (
            <Box
              key={index}
              sx={{ my: 0.75, pl: 1.25, borderLeft: '2px solid', borderColor: 'divider', opacity: 0.85 }}
            >
              <Typography variant="body2" sx={{ lineHeight: 1.65 }}>
                <Inlines tokens={block.inlines} />
              </Typography>
            </Box>
          )
        }
        if (block.kind === 'list') {
          return (
            <Box
              key={index}
              component={block.ordered ? 'ol' : 'ul'}
              sx={{ my: 0.75, pl: 2.5, '& li': { mb: 0.35 } }}
            >
              {block.items.map((item, itemIndex) => (
                <Typography key={itemIndex} component="li" variant="body2" sx={{ lineHeight: 1.65 }}>
                  <Inlines tokens={item} />
                </Typography>
              ))}
            </Box>
          )
        }
        return (
          <Typography key={index} variant="body2" sx={{ my: 0.75, lineHeight: 1.7 }}>
            <Inlines tokens={block.inlines} />
          </Typography>
        )
      })}
    </Box>
  )
}
