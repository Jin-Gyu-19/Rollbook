import re, json

with open('inner.html', encoding='utf-8') as f:
    content = f.read()
m = re.search(r'^(.*?)<!--BODY_START-->(.*?)<!--BODY_END-->(.*)$', content, re.S)
head, body, tail = m.group(1), m.group(2), m.group(3)

with open('/home/claude/work/people.json', encoding='utf-8') as f:
    people = json.load(f)
with open('/home/claude/work/groupinfo.json', encoding='utf-8') as f:
    groupinfo = json.load(f)
with open('/home/claude/work/program.json', encoding='utf-8') as f:
    program = json.load(f)
with open('/home/claude/work/dinner.json', encoding='utf-8') as f:
    dinner = json.load(f)

total = len(people)
group_count = len(groupinfo)
ai_total = sum(1 for p in people if p.get('ai'))
today = '2026-09-02'

meta = {
    "total": total,
    "groupCount": group_count,
    "aiTotal": ai_total,
    "buildDate": today,
}

def fill(html_head, html_body, html_tail, people_obj, meta_obj, program_obj, dinner_obj, self_json_str):
    esc_slash = lambda s: s.replace('</', '<\\/')
    people_json = esc_slash(json.dumps(people_obj, ensure_ascii=False))
    meta_json = esc_slash(json.dumps(meta_obj, ensure_ascii=False))
    program_json = esc_slash(json.dumps(program_obj, ensure_ascii=False))
    dinner_json = esc_slash(json.dumps(dinner_obj, ensure_ascii=False))
    t = html_tail
    t = t.replace('%%META_JSON%%', meta_json, 1)
    t = t.replace('%%PEOPLE_JSON%%', people_json, 1)
    t = t.replace('%%PROGRAM_JSON%%', program_json, 1)
    t = t.replace('%%DINNER_JSON%%', dinner_json, 1)
    t = t.replace('%%SELF_JSON%%', self_json_str, 1)
    return html_head + html_body + t

# Build the FULL_DOC_TEMPLATE (raw, with placeholders) exactly as build.py does,
# purely to compute SELF_JSON (the quine's copy of itself for in-app republish).
full_doc_template = (
    '<!doctype html>\n<html lang="ko">\n<head>\n'
    '<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + head +
    '</head>\n<body>'
    + body + tail +
    '</body>\n</html>\n'
)
self_json = json.dumps(full_doc_template, ensure_ascii=False).replace('</', '<\\/')

# Fill the REAL doc's tail with real data (not the template copy)
filled_tail = tail
esc_slash = lambda s: s.replace('</', '<\\/')
filled_tail = filled_tail.replace('%%META_JSON%%', esc_slash(json.dumps(meta, ensure_ascii=False)), 1)
filled_tail = filled_tail.replace('%%PEOPLE_JSON%%', esc_slash(json.dumps(people, ensure_ascii=False)), 1)
filled_tail = filled_tail.replace('%%PROGRAM_JSON%%', esc_slash(json.dumps(program, ensure_ascii=False)), 1)
filled_tail = filled_tail.replace('%%DINNER_JSON%%', esc_slash(json.dumps(dinner, ensure_ascii=False)), 1)
filled_tail = filled_tail.replace('%%SELF_JSON%%', self_json, 1)

standalone_html = (
    '<!doctype html>\n<html lang="ko">\n<head>\n'
    '<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + head +
    '</head>\n<body>'
    + body + filled_tail +
    '</body>\n</html>\n'
)

with open('index_standalone.html', 'w', encoding='utf-8') as f:
    f.write(standalone_html)

print('standalone length:', len(standalone_html))
for ph in ['%%PEOPLE_JSON%%', '%%META_JSON%%', '%%PROGRAM_JSON%%', '%%DINNER_JSON%%', '%%SELF_JSON%%']:
    print(ph, 'remaining:', standalone_html.count(ph))
