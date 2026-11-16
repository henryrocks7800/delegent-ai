---
name: pdf-document-creation
title: PDF Documents And Forms (create and fill)
version: 2.0.0
category: office
risk_level: low
description: "The single PDF skill: create polished PDFs (invoices, quotes, receipts, statements, letters, reports, certificates) AND fill an existing PDF form reliably. When you fill a form, keep the real form-field values (so the PDF stays editable and screen-reader friendly) and also bake the visible text into the page so it prints correctly everywhere."
activation_phrases:
  - "make a PDF"
  - "edit a PDF"
  - "read this scan"
  - "create a PDF invoice"
  - "PDF invoice"
  - "generate a PDF"
  - "PDF report"
  - "PDF letter"
  - "save as PDF"
  - "export to PDF"
  - "fill a PDF form"
  - "fill in this PDF"
  - "fill out the PDF"
  - "complete this PDF form"
  - "PDF form"
requires_human_approval: false
delegent_safe: true
---

# PDF Documents And Forms (create and fill)

This is the ONE skill for anything to do with making or filling a PDF. Do not
improvise a different PDF approach, and do not reach for a second tool: everything
below already ships in your workspace. There are two jobs it covers, and you pick
by looking at what the user gave you:

- No source PDF, they want a document produced from a description -> go to
  "Create a PDF".
- They uploaded or pointed you at an existing PDF form to complete -> go to
  "Fill an existing PDF form".

> **If PDF.co is connected** (`delegent-connect list` shows `pdf_co` with
> `"backend": "composio"`), use it for the jobs this skill does NOT cover
> well: turning a PDF into a spreadsheet or text, merging or splitting files,
> and reading a scanned PDF. Creating a PDF and filling a form stay local, as
> below, because that costs the user nothing and the file never leaves the box.

## When to use this skill

- A PDF they can send or print: an invoice, quote, receipt, statement, letter,
  report, certificate, or one-pager.
- "Fill in this form / this PDF / this application" where they gave you a PDF file
  (for example an HMRC form, a claim form, an onboarding pack) and the values.
- Converting workspace content (Markdown, HTML, a data table, an uploaded file)
  into a PDF.

## Outcome

By the end of the task, the user should have a real .pdf saved in their workspace
(for example documents/INV-1001.pdf or documents/form-filled.pdf), ready to
download from the Files tab, with correct numbers and, for a form, every value
both stored as an editable field and visible on the printed page.

## The tools you already have (no installs, no pip, no apt)

These are baked into your workspace image. Use exactly these; do not pull in
anything else:

- pypdf: read a PDF's form fields and fill them. This is your DEFAULT for filling.
- pymupdf (imported as `fitz`): fallback filler for stubborn forms, and it can
  flatten a filled form to a print-only copy if the user asks.
- reportlab: build a PDF programmatically, and stamp text onto a flat (non-form)
  PDF as an overlay.
- xhtml2pdf (pisa): render ordinary HTML and CSS to a PDF. Best for creating a
  document from a described look. Pure Python, no browser.
- For reading source data first: pdfplumber / pymupdf for text and tables from a
  PDF, pandas for a CSV.

## Create a PDF

Write the document as HTML and CSS, then render it with xhtml2pdf. Run this via
your terminal or code tool:

```python
from xhtml2pdf import pisa
html = """<html><body style="font-family: Helvetica;">
  <h1>INVOICE INV-1001</h1>
  <p>From Acme Ltd to Client Ltd, 15 Mar 2026</p>
  <table border="1" cellpadding="6" cellspacing="0" width="100%">
    <tr><th align="left">Description</th><th>Qty</th><th>Unit</th><th>Amount</th></tr>
    <tr><td>Consulting</td><td align="center">5</td><td align="right">100.00</td><td align="right">500.00</td></tr>
  </table>
  <p align="right">Subtotal 500.00 &nbsp; VAT 20% 100.00 &nbsp; <b>Total 600.00</b></p>
</body></html>"""
import os; os.makedirs("documents", exist_ok=True)
with open("documents/INV-1001.pdf", "wb") as f:
    pisa.CreatePDF(html, dest=f)
```

Use reportlab instead of xhtml2pdf only when you need precise coordinate control
or a generated chart.

## Fill an existing PDF form

This is the part the agent used to get wrong. Follow it in order and do not
deviate.

### 1. Look at the form before you fill it

First list the real field names so you fill the right boxes. Never guess field
names:

```python
from pypdf import PdfReader
reader = PdfReader("uploads/the-form.pdf")
fields = reader.get_fields()          # None if this PDF has NO form fields
print(list((fields or {}).keys()))    # the exact field names to fill
```

- If `get_fields()` returns names, this is a proper interactive form (an
  AcroForm). Use step 2 (the reliable path).
- If it returns None or an empty dict, there are NO fillable fields. It is a flat
  or scanned PDF. Use step 3 (overlay), and if it is a scan, say so plainly.

### 2. Fill a real form (the reliable default: editable AND printable)

Fill the field values with pypdf. `update_page_form_field_values` writes each
value into the field AND regenerates the field's visible appearance, so the text
is baked onto the page and prints correctly in any viewer, while the field itself
stays a real, editable, screen-reader-readable form field. Also set
NeedAppearances so form-aware viewers refresh their own rendering. Doing both is
what makes this robust:

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("uploads/the-form.pdf")
writer = PdfWriter(clone_from=reader)

values = {
    "full_name": "Jane Smith",
    "date": "20 Jul 2026",
    "amount": "1250.00",
}

for page in writer.pages:
    writer.update_page_form_field_values(page, values, auto_regenerate=False)

# Belt and braces: tell form-aware viewers to regenerate appearances too, so the
# value shows whether the reader trusts our baked appearance or rebuilds its own.
try:
    writer.set_need_appearances_writer(True)
except Exception:
    pass

import os; os.makedirs("documents", exist_ok=True)
with open("documents/form-filled.pdf", "wb") as f:
    writer.write(f)
```

Checkboxes and radio buttons: their value is the field's on-state name, not the
word "true". Read the allowed states before setting one:

```python
info = reader.get_fields()["gift_aid"]
print(info.get("/_States_"))   # e.g. ['/Yes', '/Off']  -> set values["gift_aid"] = "/Yes"
```

If a value does not appear when you open the result, that is almost always a
checkbox set to a wrong state name, or a field name typo. Re-list the fields and
fix it; do not fall back to stamping text over a working form.

Stubborn form (rare): if a specific PDF will not render values with pypdf, fill it
with pymupdf instead, which writes and updates the widget appearance itself:

```python
import fitz  # pymupdf
doc = fitz.open("uploads/the-form.pdf")
for page in doc:
    for w in page.widgets() or []:
        if w.field_name in values:
            w.field_value = values[w.field_name]
            w.update()
doc.save("documents/form-filled.pdf")
```

If the user explicitly wants a locked, print-only copy with no editable fields,
flatten it AFTER filling: with pymupdf call `doc.bake()` (this turns the filled
widgets into static page content) and then `doc.save("documents/form-flat.pdf")`.
Keep the editable version too unless they tell you not to.

### 3. Flat or scanned PDF (no form fields)

There are no fields to fill, so you stamp the text onto the page as an overlay.
Build a one-page overlay with reportlab at the right coordinates and merge it over
the original with pypdf. Be honest with the user: this bakes visible text for
printing but does NOT create editable form fields (there were none to begin
with), and if the file is a scan you may need to place text by eye.

```python
from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter
import io

buf = io.BytesIO()
c = canvas.Canvas(buf)
c.drawString(120, 700, "Jane Smith")     # x, y in points from bottom-left
c.drawString(120, 660, "20 Jul 2026")
c.save(); buf.seek(0)

base = PdfReader("uploads/the-form.pdf")
overlay = PdfReader(buf)
writer = PdfWriter()
page = base.pages[0]
page.merge_page(overlay.pages[0])
writer.add_page(page)
for p in base.pages[1:]:
    writer.add_page(p)
with open("documents/form-filled.pdf", "wb") as f:
    writer.write(f)
```

## Non-negotiable safety rules

- Do not invent figures or answers. Use only the names, numbers, dates, and terms
  the user gave you, or values you computed from data they provided, and show the
  arithmetic for any total or tax line. If a form field is unclear, ask; never
  guess a value onto an official form.
- Creating or filling a PDF in the workspace is routine, safe work: do it
  directly. Pause for confirmation only before genuinely destructive or external
  actions (overwriting an existing important file, emailing the PDF, submitting or
  filing it anywhere, or anything involving payment).
- A generated or filled document is a draft the user reviews and submits
  themselves. Never present it as a filed, lodged, or legally submitted document,
  and never submit an official form yourself.
- Do not give regulated tax, legal, or accounting conclusions as final
  professional advice; prepare the document for human review.
- Never say the PDF is done until you have actually written the file, confirmed it
  exists and is non-empty, and (for a form) confirmed the values are visible in
  the output.

## Intake questions

Ask only what is missing.

- Creating: who it is from and to; line items (description, quantity, unit price);
  tax or VAT rate, currency, number, dates, terms; any branding or layout wish.
- Filling: which uploaded file is the form; the value for each field you listed;
  for any checkbox, the choice; where to save the result.

## Execution playbook

1. Decide the job: create from a description, or fill a PDF the user gave you.
2. Creating: gather details, compute and double-check totals, lay out with
   xhtml2pdf (or reportlab), write the .pdf.
3. Filling: list the real field names first; if it is a real form, fill with pypdf
   (values + regenerated appearances + NeedAppearances) so it is both editable and
   printable; if it is flat or scanned, overlay with reportlab and say so.
4. Write the .pdf to a sensible workspace path (documents/<name>.pdf), creating the
   folder if needed.
5. Verify the file exists, is non-empty, and shows the right content.
6. Tell the user the path, the key figure or the fields you filled, and how to
   download it from the Files tab.

## Verification checklist

- The .pdf exists in the workspace and is a real, non-empty PDF.
- Creating: totals reconcile (subtotal plus tax equals grand total) and match the
  user's figures; names, dates, number, and currency are correct.
- Filling: re-open the result and confirm each value is visible; for a real form,
  confirm the fields are still present and editable (you did not accidentally
  flatten unless asked).
- The layout renders cleanly (no broken table, no overflow, no text off the page).

## Handover template

```text
What I did:
- Created / filled <path>.pdf (<type>).

Evidence:
- File exists at <path>, <size> bytes; values verified visible in the output.

Files / systems touched:
- <path>

What still needs your approval:
- Sending, submitting, or filing it (I prepared it; you send or file it).

Next recommended step:
- Download it from the Files tab and review it before you send or submit it.
```

## Related skills

- report-writer (renders its final PDF through this skill)
- autonomous-bookkeeper
- spreadsheet-excel
