// Simple line icons drawn for MineDeck (24x24 grid).
import { svg } from './ui.js'

const P = {
  plus: ['M12 5v14', 'M5 12h14'],
  play: [{ tag: 'path', d: 'M7 5l12 7-12 7z', fill: 'currentColor', stroke: 'none' }],
  stop: [{ tag: 'rect', x: '6', y: '6', width: '12', height: '12', rx: '2', fill: 'currentColor', stroke: 'none' }],
  settings: [{ tag: 'circle', cx: '12', cy: '12', r: '3' }, 'M12 2.5v3', 'M12 18.5v3', 'M2.5 12h3', 'M18.5 12h3', 'M5.3 5.3l2.1 2.1', 'M16.6 16.6l2.1 2.1', 'M5.3 18.7l2.1-2.1', 'M16.6 7.4l2.1-2.1'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
  more: [{ tag: 'circle', cx: '5', cy: '12', r: '1.6', fill: 'currentColor' }, { tag: 'circle', cx: '12', cy: '12', r: '1.6', fill: 'currentColor' }, { tag: 'circle', cx: '19', cy: '12', r: '1.6', fill: 'currentColor' }],
  copy: [{ tag: 'rect', x: '8', y: '8', width: '12', height: '12', rx: '2' }, 'M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  search: [{ tag: 'circle', cx: '11', cy: '11', r: '6.5' }, 'M20 20l-4.3-4.3'],
  chevron: ['M6 9l6 6 6-6'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  send: ['M4 12l16-8-6 16-2.5-6.5z', 'M11.5 13.5L20 4'],
  users: [{ tag: 'circle', cx: '9', cy: '8', r: '3.5' }, 'M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5', 'M16 4.8a3.5 3.5 0 0 1 0 6.4', 'M18.5 14.8c1.6.8 2.6 2.6 3 5.2'],
  chat: ['M4 5h16v11H9l-5 4z'],
  server: [{ tag: 'rect', x: '3', y: '4', width: '18', height: '7', rx: '1.5' }, { tag: 'rect', x: '3', y: '13', width: '18', height: '7', rx: '1.5' }, 'M7 7.5h.01', 'M7 16.5h.01'],
  signal: ['M4 20v-3', 'M9 20v-7', 'M14 20v-11', 'M19 20V5'],
  heart: [{ tag: 'path', d: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z', fill: 'currentColor', stroke: 'none' }],
  clock: [{ tag: 'circle', cx: '12', cy: '12', r: '8.5' }, 'M12 7.5V12l3 2'],
  grid: [{ tag: 'rect', x: '4', y: '4', width: '6.5', height: '6.5', rx: '1' }, { tag: 'rect', x: '13.5', y: '4', width: '6.5', height: '6.5', rx: '1' }, { tag: 'rect', x: '4', y: '13.5', width: '6.5', height: '6.5', rx: '1' }, { tag: 'rect', x: '13.5', y: '13.5', width: '6.5', height: '6.5', rx: '1' }],
  repeat: ['M17 3l3 3-3 3', 'M4 11V9a3 3 0 0 1 3-3h13', 'M7 21l-3-3 3-3', 'M20 13v2a3 3 0 0 1-3 3H4'],
  branch: [{ tag: 'circle', cx: '6', cy: '5', r: '2' }, { tag: 'circle', cx: '6', cy: '19', r: '2' }, { tag: 'circle', cx: '18', cy: '8', r: '2' }, 'M6 7v10', 'M18 10c0 4-6 3-11.3 7.5'],
  eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', { tag: 'circle', cx: '12', cy: '12', r: '3' }],
  box: ['M4 8l8-4 8 4v8l-8 4-8-4z', 'M4 8l8 4 8-4', 'M12 12v8'],
  mouse: [{ tag: 'rect', x: '6', y: '3', width: '12', height: '18', rx: '6' }, 'M12 7v4'],
  food: [{ tag: 'path', d: 'M7 4c4 0 8 3 8 8 0 3-2 5-5 5-4 0-6-3-6-7 0-3 1-6 3-6z', fill: 'currentColor', stroke: 'none' }, 'M14 16l5 5'],
  shield: ['M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z', 'M8.5 12l2.5 2.5 4.5-5'],
  alert: ['M12 4l9 16H3z', 'M12 10v4', 'M12 17h.01'],
  pin: ['M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z', { tag: 'circle', cx: '12', cy: '10', r: '2.2' }],
  folder: ['M3 6.5a1.5 1.5 0 0 1 1.5-1.5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z'],
  down: ['M12 5v14', 'M6 13l6 6 6-6'],
  up: ['M12 19V5', 'M6 11l6-6 6 6'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  key: [{ tag: 'circle', cx: '8', cy: '15', r: '4' }, 'M11 12l9-9', 'M17 6l3 3', 'M15 8l2 2'],
  bolt: [{ tag: 'path', d: 'M13 2L4 14h7l-1 8 9-12h-7z', fill: 'currentColor', stroke: 'none' }],
  merge: ['M7 4v5a5 5 0 0 0 5 5h5', 'M14 11l3 3-3 3', 'M7 20v-6']
}

export function icon (name, size = 16, extra) {
  return svg(P[name] || P.alert, size, extra)
}
