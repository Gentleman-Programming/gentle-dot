import { createHash } from 'node:crypto';

// InputControl 0.2.1 cleanup algorithms, excluding blank/comment/docstring lines.
// Full module provenance is still the builder's responsibility.
const shapes = {
  _release_pressed_keys: '3ee153270cea4373bf4f81bc11fbb145f47bdb08bbf43aa36f5c17155b99dbdf',
  hotkey: 'f38ffffd8a49eabd1ed4f25e9c125d55d7b784464bef4c23f311f118687276d2',
  drag: 'a8a6f6fe9a5132138d52c873587bb7aa7d1eeb93720dd54aefc7ac8fbe39e2a2',
};
const normalized = text => text.split('\n').filter(line =>
  line.trim() && !/^\s*(#|""".*""")/.test(line)).join('\n').trimEnd();

/** Generate a separate Dot-only keyboard or mouse source; never mutates inputs. */
export function inputControlReleaseForClient(source, { client = 'upstream', module } = {}) {
  if (typeof source !== 'string') throw new TypeError('Expected InputControl release source');
  if (client !== 'gentle-dot') return source;
  if (!['keyboard', 'mouse'].includes(module)) throw new Error('Unsupported InputControl release module');
  const fail = () => { throw new Error('Unsupported InputControl release source: expected pinned cleanup'); };
  if (source.includes('_dot_')) fail();
  // Scope edits to unique ordinary top-level functions; never rewrite the module.
  const functions = [...source.matchAll(/^def (\w+)\([^]*?(?=^def |^class |$(?![^]))/gm)];
  const get = name => {
    const matches = functions.filter(match => match[1] === name);
    if (matches.length !== 1 || createHash('sha256').update(normalized(matches[0][0])).digest('hex') !== shapes[name]) fail();
    return matches[0];
  };
  const replaceOne = (text, from, to) => {
    if (text.split(from).length !== 2) fail();
    return text.replace(from, to);
  };
  const changes = [];
  if (module === 'keyboard') {
    const release = get('_release_pressed_keys'), hotkey = get('hotkey');
    if ((source.match(/_release_pressed_keys\(pressed_keys\)/g) || []).length !== 2) fail();
    const cancelCall = '            _release_pressed_keys(pressed_keys)\n        except Exception:\n            pass';
    const normalCall = '    try:\n        _release_pressed_keys(pressed_keys)\n    except Exception:\n';
    let chord = replaceOne(hotkey[0], cancelCall, cancelCall.replace('(pressed_keys)', '(pressed_keys, manager)'));
    chord = replaceOne(chord, normalCall, normalCall.replace('(pressed_keys)', '(pressed_keys, manager)'));
    let cleanup = replaceOne(release[0], '(pressed_keys: list[str])', '(pressed_keys: list[str], manager: ControlManager)');
    cleanup = replaceOne(cleanup, '        raise release_error',
      '        manager._dot_release_failed = True\n        raise release_error');
    changes.push([release, cleanup], [hotkey, chord]);
  } else {
    const drag = get('drag');
    const audit = '            except Exception:\n                _record(manager, session_id, "mouse_up", {"success": False})';
    changes.push([drag, replaceOne(drag[0], audit,
      '            except Exception:\n                manager._dot_release_failed = True\n                _record(manager, session_id, "mouse_up", {"success": False})')]);
  }
  // Reverse offsets keep every other byte (including comments/newlines) intact.
  for (const [match, replacement] of changes.sort((a, b) => b[0].index - a[0].index)) {
    source = source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
  }
  return source;
}
