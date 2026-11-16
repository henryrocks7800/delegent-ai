"""Small, fail-closed compatibility patch for the pinned native compressor.

Keep Hermes' algorithm. Agree the output budget with our authenticated proxy,
and let native failure handling preserve context if a summary is truncated.
"""
from pathlib import Path
import sys

LIMIT = 16384
MARKER = '# Delegent summary output contract v1'


def patch(source: str) -> str:
    if MARKER in source:
        return source
    budget = '                "task": "compression",\n'
    response = '            message = response.choices[0].message\n'
    if source.count(budget) != 1 or source.count(response) != 1:
        raise RuntimeError('Pinned Hermes compressor changed; review the summary output contract before building')
    source = source.replace(budget, budget + f'                "max_tokens": {LIMIT},  {MARKER}\n')
    return source.replace(response,
        '            if getattr(response.choices[0], "finish_reason", None) in ("length", "max_tokens"):\n'
        '                raise RuntimeError("Compression summary was truncated; keep the existing context")\n' + response)


if __name__ == '__main__':
    path = Path(sys.argv[1]) / 'agent' / 'context_compressor.py'
    path.write_text(patch(path.read_text(encoding='utf-8')), encoding='utf-8')
