import re, json, datetime

with open('inner.html', encoding='utf-8') as f:
    content = f.read()
m = re.search(r'^(.*?)<!--BODY_START-->(.*?)<!--BODY_END-->(.*)$', content, re.S)
head, body, tail = m.group(1), m.group(2), m.group(3)

# ---- Real current data ----
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
today = '2026-09-02'  # rebuild with lineup data merged in

meta = {
    "total": total,
    "groupCount": group_count,
    "aiTotal": ai_total,
    "buildDate": today,
}

# ---- Build FRAGMENT (for Artifact tool's file_path publish — auto-wraps in skeleton) ----
fragment_head = head
fragment_body = body
fragment_tail = tail

def fill(html_head, html_body, html_tail, people_obj, meta_obj, program_obj, dinner_obj, self_json_str):
    esc_slash = lambda s: s.replace('</', '<\\/')
    people_json = esc_slash(json.dumps(people_obj, ensure_ascii=False))
    meta_json = esc_slash(json.dumps(meta_obj, ensure_ascii=False))
    program_json = esc_slash(json.dumps(program_obj, ensure_ascii=False))
    dinner_json = esc_slash(json.dumps(dinner_obj, ensure_ascii=False))
    t = html_tail
    # IMPORTANT: only substitute the FIRST occurrence of each token — that's the
    # top-level `const X = %%TOKEN%%;` declaration. The buildHtml() function later
    # in this same tail contains these tokens AGAIN as literal JS string-literal
    # arguments (e.g. html.replace('%%SELF_JSON%%', selfJson)) — those must stay
    # untouched so future client-side republishing still works. A blind global
    # replace corrupts that call site by injecting the huge JSON blob into it.
    t = t.replace('%%META_JSON%%', meta_json, 1)
    t = t.replace('%%PEOPLE_JSON%%', people_json, 1)
    t = t.replace('%%PROGRAM_JSON%%', program_json, 1)
    t = t.replace('%%DINNER_JSON%%', dinner_json, 1)
    t = t.replace('%%SELF_JSON%%', self_json_str, 1)
    return html_head + html_body + t

# Step 1: build the FULL_DOC_TEMPLATE (with placeholders still present in tail, since this
# is used purely as the quine source string, substituted client-side later) — this must be
# a COMPLETE document (doctype/html/head/body) since it's what claude.use('artifact').publish()
# will receive on republish.
full_doc_template = (
    '<!doctype html>\n<html lang="ko">\n<head>\n'
    '<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + head +
    '</head>\n<body>'
    + body + tail +
    '</body>\n</html>\n'
)

# Step 2: compute SELF_JSON = JSON.stringify(full_doc_template), with </ escaped, as a JS string literal
self_json = json.dumps(full_doc_template, ensure_ascii=False).replace('</', '<\\/')

# Step 3: build the FRAGMENT with all four placeholders filled with real data — this is
# what gets published via the Artifact TOOL (file_path), which auto-wraps in the skeleton.
final_html = fill(fragment_head, fragment_body, fragment_tail, people, meta, program, dinner, self_json)

with open('index_fragment.html', 'w', encoding='utf-8') as f:
    f.write(final_html)

print('total people:', total)
print('group count:', group_count)
print('ai total:', ai_total)
print('fragment length:', len(final_html))
print('full_doc_template length (unfilled):', len(full_doc_template))

# sanity: confirm no leftover unescaped placeholders in head/body (only tail should have had them)
for ph in ['%%PEOPLE_JSON%%', '%%META_JSON%%', '%%PROGRAM_JSON%%', '%%DINNER_JSON%%', '%%SELF_JSON%%']:
    cnt = final_html.count(ph)
    print(ph, 'remaining occurrences in final_html:', cnt)
