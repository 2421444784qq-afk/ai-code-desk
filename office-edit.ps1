param(
  [Parameter(Mandatory=$true)][ValidateSet('word','excel','visio')][string]$Kind,
  [Parameter(Mandatory=$true)][string]$InputPath,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [Parameter(Mandatory=$true)][string]$SpecPath
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$spec = Get-Content -LiteralPath $SpecPath -Raw -Encoding UTF8 | ConvertFrom-Json
$result = $null

if ($Kind -eq 'word') {
  $app = New-Object -ComObject Word.Application
  $app.Visible = $false; $app.DisplayAlerts = 0
  $doc = $null
  try {
    $doc = $app.Documents.Open($InputPath, $false, $true)
    $doc.SaveAs([ref]$OutputPath, [ref]16)  # wdFormatDocumentDefault (.docx)
    $actions = @($spec.actions)
    if ($actions.Count -lt 1) { throw 'Word 编辑需要 actions 列表。' }
    $appended = @()
    foreach ($a in $actions) {
      $type = [string]$a.type
      if ($type -eq 'replace') {
        $find = $doc.Content.Find
        [void]$find.Execute([string]$a.find, $false, $false, $false, $false, $false, $true, 1, $false, [string]$a.replace, 2)
      }
      elseif ($type -eq 'append_heading') {
        $level = [int]$a.level; if ($level -lt 1 -or $level -gt 3) { $level = 1 }
        $rng = $doc.Content; [void]$rng.Collapse(0)
        [void]$rng.InsertAfter("`r" + [string]$a.text)
        $doc.Paragraphs.Last.Style = -$level   # wdStyleHeading1..3
        $appended += [string]$a.text
      }
      elseif ($type -eq 'append_paragraph') {
        $rng = $doc.Content; [void]$rng.Collapse(0)
        [void]$rng.InsertAfter("`r" + [string]$a.text)
        $appended += [string]$a.text
      }
      elseif ($type -eq 'append_table') {
        $rows = @($a.rows)
        if ($rows.Count -lt 1) { throw '表格需要至少一行。' }
        $cols = @($rows[0]).Count
        if ($cols -lt 1) { throw '表格需要至少一列。' }
        $rng = $doc.Content; [void]$rng.Collapse(0)
        $tbl = $doc.Tables.Add($rng, $rows.Count, $cols)
        $tbl.Borders.Enable = $true
        for ($r = 0; $r -lt $rows.Count; $r++) {
          for ($c = 0; $c -lt $cols; $c++) {
            $tbl.Cell($r + 1, $c + 1).Range.Text = [string]$rows[$r][$c]
          }
        }
      }
      else { throw ('未知 Word 编辑类型：' + $type) }
    }
    $doc.Save()
    $full = $doc.Content.Text
    $contains = @()
    foreach ($item in $appended) {
      $short = $item.Substring(0, [Math]::Min(80, $item.Length))
      $contains += @{ text = $short; found = $full.Contains($item) }
    }
    $result = @{ kind = 'word'; output = $OutputPath; paragraphs = $doc.Paragraphs.Count; tables = $doc.Tables.Count; characters = $full.Length; appendedCheck = $contains }
  } finally {
    if ($doc) { try { $doc.Close(0) } catch {}; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($doc) }
    if ($app) { try { $app.Quit() } catch {}; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  }
}
elseif ($Kind -eq 'excel') {
  $app = New-Object -ComObject Excel.Application
  $app.Visible = $false; $app.DisplayAlerts = $false
  $wb = $null
  try {
    $wb = $app.Workbooks.Open($InputPath, 0, $true)
    $wb.SaveAs($OutputPath, 51)   # xlOpenXMLWorkbook (.xlsx)
    $cells = @($spec.cells)
    if ($cells.Count -lt 1) { throw 'Excel 编辑需要 cells 列表。' }
    $written = @()
    foreach ($item in $cells) {
      $sheetName = [string]$item.sheet; $cellRef = [string]$item.cell; $value = [string]$item.value
      if ($cellRef -notmatch '^[A-Za-z]{1,3}\d+$') { throw ('单元格地址无效：' + $cellRef) }
      $ws = $null
      foreach ($sh in $wb.Worksheets) { if ($sh.Name -eq $sheetName) { $ws = $sh; break } }
      if ($null -eq $ws) { throw ('找不到工作表：' + $sheetName) }
      if ($value.StartsWith('=')) { $ws.Range($cellRef).Formula = $value }
      else { $ws.Range($cellRef).Value2 = $value }
      $written += @{ sheet = $sheetName; cell = $cellRef }
    }
    try { [void]$app.CalculateFull() } catch {}
    $wb.Save()
    $checks = @(); $errorCells = @()
    foreach ($item in $written) {
      $ws = $null
      foreach ($sh in $wb.Worksheets) { if ($sh.Name -eq $item.sheet) { $ws = $sh; break } }
      $range = $ws.Range($item.cell)
      $display = [string]$range.Text
      $isError = $display.StartsWith('#')
      $checks += @{ sheet = $item.sheet; cell = $item.cell; text = $display.Substring(0, [Math]::Min(60, $display.Length)); error = $isError }
      if ($isError) { $errorCells += ($item.sheet + '!' + $item.cell + ' = ' + $display) }
    }
    $sheets = @()
    foreach ($sh in $wb.Worksheets) { $sheets += @{ name = $sh.Name; rows = $sh.UsedRange.Rows.Count; columns = $sh.UsedRange.Columns.Count } }
    $result = @{ kind = 'excel'; output = $OutputPath; sheets = $sheets; checks = $checks; errorCells = $errorCells; recalculated = $true }
  } finally {
    if ($wb) { try { $wb.Close($false) } catch {}; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($wb) }
    if ($app) { try { $app.Quit() } catch {}; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  }
}
elseif ($Kind -eq 'visio') {
  $app = New-Object -ComObject Visio.Application
  $app.Visible = $false
  $doc = $null
  try {
    $doc = $app.Documents.OpenEx($InputPath, 1)   # visOpenRO：原文件只读打开
    $actualOutput = $OutputPath
    $fallbackNote = $null
    try {
      $doc.SaveAs($OutputPath)
    } catch {
      # 未激活的 Visio 拒绝保存 .vsdx（HRESULT 0x80010001 / 0x86DB03E7），但允许保存旧版 .vsd。
      $vsdPath = [System.IO.Path]::ChangeExtension($OutputPath, '.vsd')
      $doc.SaveAs($vsdPath)
      $actualOutput = $vsdPath
      $fallbackNote = '本机 Visio 未激活，副本已保存为旧版 .vsd 格式；激活后可正常保存 .vsdx。'
    }
    $steps = @($spec.steps)
    if ($steps.Count -lt 2 -or $steps.Count -gt 8) { throw '流程包含 2 至 8 步。' }
    $page = $doc.Pages.Add()
    $pageTitle = [string]$spec.pageTitle
    if ($pageTitle) { $page.Name = $pageTitle }
    $start = $page.DrawOval(1.0, 1.7, 2.2, 2.3); $start.Text = '开始'
    $prev = $start; $n = 0
    foreach ($s in $steps) {
      $x1 = 2.6 + $n * 1.9; $x2 = $x1 + 1.6
      $sh = $page.DrawRectangle($x1, 1.5, $x2, 2.5)
      $sh.Text = ('{0:D2}  {1}' -f ($n + 1), [string]$s)
      $conn = $page.DrawLine($x1 - 0.4, 2.0, $x1, 2.0)
      try { $conn.CellsU('EndArrow').FormulaU = '4' } catch {}
      $prev = $sh; $n++
    }
    $x1 = 2.6 + $n * 1.9
    $end = $page.DrawOval($x1, 1.7, $x1 + 1.2, 2.3); $end.Text = '结束'
    $conn = $page.DrawLine($x1 - 0.4, 2.0, $x1, 2.0)
    try { $conn.CellsU('EndArrow').FormulaU = '4' } catch {}
    try { $doc.Save() } catch { throw 'Visio 未激活（产品激活失败），无法保存编辑副本，请先激活 Visio。' }
    $result = @{ kind = 'visio'; output = $actualOutput; pages = $doc.Pages.Count; page = $page.Name; shapes = $page.Shapes.Count; steps = $n; connectors = ($n + 1) }
    if ($fallbackNote) { $result.note = $fallbackNote }
  } finally {
    if ($doc) { try { $doc.Close() } catch {}; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($doc) }
    if ($app) { try { $app.Quit() } catch {}; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  }
}
if ($null -eq $result) { throw '未生成编辑结果。' }
$result | ConvertTo-Json -Depth 8 -Compress
