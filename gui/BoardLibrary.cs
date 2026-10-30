using System;
using System.Linq;
using System.Drawing;
using System.Collections.Generic;
using System.Windows.Forms;

namespace StockWindow {
 sealed class BoardEntry {public string Name="";public bool Selected;}
 // 每个格子对应一个板块，底色只取决于本轮选择；焦点移动不会改变选择。
 sealed class BoardLibrary : UserControl {
  const int ColumnCount=4,MinimumRows=3;
  public readonly List<BoardEntry> Entries=new List<BoardEntry>();
  public readonly DataGridView Grid=new DataGridView();
  public readonly Button AddButton=new Button(),EditButton=new Button(),DeleteButton=new Button();
  public event Action Changed;public event Action<string> Message;
  bool rebuilding,lastEditValid=true;BoardEntry clickEntry;bool beforeClickSelected;
  public BoardLibrary(){
   Dock=DockStyle.Fill;
   var layout=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=1,RowCount=2,Margin=Padding.Empty};layout.RowStyles.Add(new RowStyle(SizeType.Absolute,31));layout.RowStyles.Add(new RowStyle(SizeType.Percent,100));Controls.Add(layout);
   var tools=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=4,RowCount=1,Margin=Padding.Empty};tools.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));for(int n=0;n<3;n++)tools.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,64));tools.Controls.Add(new Label {Text="单击选中 / 取消；双击修改",Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleLeft},0,0);
   int column=1;foreach(var b in new[]{AddButton,EditButton,DeleteButton}){b.Text=column==1?"添加":column==2?"修改":"删除";b.Dock=DockStyle.Fill;tools.Controls.Add(b,column++,0);}layout.Controls.Add(tools,0,0);
   Grid.Dock=DockStyle.Fill;Grid.AllowUserToAddRows=false;Grid.AllowUserToDeleteRows=false;Grid.AllowUserToResizeRows=false;Grid.AllowUserToResizeColumns=false;Grid.RowHeadersVisible=false;Grid.ColumnHeadersVisible=false;Grid.MultiSelect=false;Grid.SelectionMode=DataGridViewSelectionMode.CellSelect;Grid.BackgroundColor=SystemColors.Window;Grid.BorderStyle=BorderStyle.FixedSingle;Grid.AutoGenerateColumns=false;Grid.EditMode=DataGridViewEditMode.EditProgrammatically;Grid.AccessibleName="板块表格：单击选中，再次单击取消";
   Grid.DefaultCellStyle.Alignment=DataGridViewContentAlignment.MiddleLeft;Grid.DefaultCellStyle.Padding=new Padding(5,0,2,0);Grid.DefaultCellStyle.BackColor=Grid.DefaultCellStyle.SelectionBackColor=SystemColors.Window;Grid.DefaultCellStyle.ForeColor=Grid.DefaultCellStyle.SelectionForeColor=SystemColors.WindowText;
   for(int n=0;n<ColumnCount;n++)Grid.Columns.Add(new DataGridViewTextBoxColumn {Name="board"+n,AutoSizeMode=DataGridViewAutoSizeColumnMode.Fill,MinimumWidth=70,SortMode=DataGridViewColumnSortMode.NotSortable});layout.Controls.Add(Grid,0,1);
   AddButton.Click+=delegate{if(!Commit())return;Edit(AddSector(""));};EditButton.Click+=delegate{if(Commit())Edit(Current());};DeleteButton.Click+=delegate{Remove(Current());};
   Grid.CellMouseClick+=delegate(object sender,DataGridViewCellMouseEventArgs e){if(e.Button==MouseButtons.Left&&e.Clicks==1)ToggleCell(Cell(e.RowIndex,e.ColumnIndex));};
   Grid.CellMouseDoubleClick+=delegate(object sender,DataGridViewCellMouseEventArgs e){if(e.Button==MouseButtons.Left)EditDoubleCell(Cell(e.RowIndex,e.ColumnIndex));};
   Grid.CellEndEdit+=NameEdited;Grid.SizeChanged+=delegate{SizeRows();};
   Grid.KeyDown+=delegate(object sender,KeyEventArgs e){if(Grid.IsCurrentCellInEditMode)return;if(e.KeyCode==Keys.Space||e.KeyCode==Keys.Enter){ToggleCell(Grid.CurrentCell);e.Handled=e.SuppressKeyPress=true;}else if(e.KeyCode==Keys.F2){Edit(Current());e.Handled=e.SuppressKeyPress=true;}else if(e.KeyCode==Keys.Delete){Remove(Current());e.Handled=e.SuppressKeyPress=true;}};
   Grid.DataError+=delegate(object sender,DataGridViewDataErrorEventArgs e){e.ThrowException=false;};RefreshRows();
  }
  static bool Valid(string name){return !String.IsNullOrWhiteSpace(name)&&name.Length<=80&&name.IndexOfAny(new[]{',','，',';','；','\r','\n'})<0;}
  void Say(string value){if(Message!=null)Message(value);}
  void Notify(){if(Changed!=null)Changed();}
  DataGridViewCell Cell(int row,int column){return row<0||row>=Grid.Rows.Count||column<0||column>=Grid.Columns.Count?null:Grid.Rows[row].Cells[column];}
  public List<string> Names {get{return Entries.Select(e=>e.Name).Where(Valid).Distinct().ToList();}}
  public List<string> SelectedNames {get{return Entries.Where(e=>e.Selected&&Valid(e.Name)).Select(e=>e.Name).Distinct().ToList();}}
  public BoardEntry Current(){return Grid.CurrentCell==null?null:Grid.CurrentCell.Tag as BoardEntry;}
  public DataGridViewCell FindCell(BoardEntry entry){if(entry==null)return null;foreach(DataGridViewRow row in Grid.Rows)foreach(DataGridViewCell cell in row.Cells)if(cell.Tag==entry)return cell;return null;}
  void PaintCell(DataGridViewCell cell){
   var entry=cell.Tag as BoardEntry;bool selected=entry!=null&&Valid(entry.Name)&&entry.Selected;Color back=selected?SystemColors.Highlight:SystemColors.Window,fore=selected?SystemColors.HighlightText:SystemColors.WindowText;cell.Style.BackColor=cell.Style.SelectionBackColor=back;cell.Style.ForeColor=cell.Style.SelectionForeColor=fore;cell.ToolTipText=entry==null?"":entry.Name;
  }
  void SizeRows(){
   if(Grid.Rows.Count==0)return;int available=Math.Max(0,Grid.ClientSize.Height-4),minimum=Math.Max(26,Font.Height+12);bool fits=Grid.Rows.Count*minimum<=available;int height=fits?available/Grid.Rows.Count:minimum,remainder=fits?available%Grid.Rows.Count:0;foreach(DataGridViewRow row in Grid.Rows)row.Height=height+(row.Index<remainder?1:0);
  }
  public void RefreshRows(){
   var current=Current();int scroll=Grid.FirstDisplayedScrollingRowIndex;rebuilding=true;try{Grid.Rows.Clear();int count=Math.Max(MinimumRows,(Entries.Count+ColumnCount-1)/ColumnCount);Grid.Rows.Add(count);for(int n=0;n<count*ColumnCount;n++){var cell=Grid.Rows[n/ColumnCount].Cells[n%ColumnCount];var entry=n<Entries.Count?Entries[n]:null;cell.Tag=entry;cell.Value=entry==null?"":entry.Name;cell.ReadOnly=entry==null;PaintCell(cell);}var focused=FindCell(current);if(focused!=null)Grid.CurrentCell=focused;Grid.ClearSelection();SizeRows();if(scroll>=0&&scroll<Grid.Rows.Count)Grid.FirstDisplayedScrollingRowIndex=scroll;}finally{rebuilding=false;}
  }
  public bool Commit(){if(!Grid.IsCurrentCellInEditMode)return true;lastEditValid=true;Grid.EndEdit();return lastEditValid;}
  public BoardEntry AddSector(string value){
   value=(value??"").Trim();if(value.Length>0&&!Valid(value)){Say("每格填写一个板块名称，最多80字。");return null;}
   var entry=Entries.FirstOrDefault(e=>e.Name==value);if(entry==null){entry=Entries.FirstOrDefault(e=>e.Name.Length==0);if(entry==null){entry=new BoardEntry();Entries.Insert(0,entry);}entry.Name=value;}
   if(Entries.Count(e=>e!=entry&&e.Selected&&Valid(e.Name))<10)entry.Selected=true;else{entry.Selected=false;Say("本轮最多选择10个板块；新板块已保存，可取消其他选择后再选。");}RefreshRows();Notify();return entry;
  }
  public void Remember(string value){value=(value??"").Trim();if(!Valid(value))return;var entry=Entries.FirstOrDefault(e=>e.Name==value);if(entry==null)entry=new BoardEntry {Name=value};else Entries.Remove(entry);Entries.Insert(0,entry);RefreshRows();Notify();}
  public void LoadNames(IEnumerable<string> names){foreach(var value in names.Reverse()){string name=(value??"").Trim();if(Valid(name)&&!Entries.Any(e=>e.Name==name))Entries.Insert(0,new BoardEntry {Name=name});}RefreshRows();Notify();}
  public void SetSelected(string name,bool value){var entry=Entries.FirstOrDefault(e=>e.Name==name);if(entry==null)return;if(value&&!entry.Selected&&SelectedNames.Count>=10){Say("本轮最多选择10个板块。");return;}entry.Selected=value;var cell=FindCell(entry);if(cell!=null)PaintCell(cell);Notify();}
  public void ToggleCell(DataGridViewCell cell){if(!Enabled||cell==null||Grid.IsCurrentCellInEditMode)return;var entry=cell.Tag as BoardEntry;if(entry==null||!Valid(entry.Name))return;clickEntry=entry;beforeClickSelected=entry.Selected;SetSelected(entry.Name,!entry.Selected);}
  public void EditDoubleCell(DataGridViewCell cell){var entry=cell==null?null:cell.Tag as BoardEntry;if(!Enabled||entry==null)return;if(entry==clickEntry)SetSelected(entry.Name,beforeClickSelected);clickEntry=null;Edit(entry);}
  public void ReplaceSelection(IEnumerable<string> names){var values=names.Where(Valid).Distinct().ToArray();if(values.Length>10)throw new Exception("原任务板块超过10个，请检查原记录。");foreach(var entry in Entries)entry.Selected=false;foreach(string value in values){var entry=Entries.FirstOrDefault(e=>e.Name==value);if(entry==null){entry=new BoardEntry {Name=value};Entries.Add(entry);}entry.Selected=true;}RefreshRows();Notify();}
  public void Remove(BoardEntry entry){if(entry==null)return;Grid.CancelEdit();Entries.Remove(entry);clickEntry=null;RefreshRows();Notify();}
  public bool Rename(BoardEntry entry,string value){
   value=(value??"").Trim();if(entry==null)return false;if(!Valid(value)){Say("板块名称不能为空、超过80字或包含分隔符；删除请点“删除”。");return false;}if(Entries.Any(e=>e!=entry&&e.Name==value)){Say("表格中已有这个板块，已保留原名称。");return false;}if(entry.Selected&&!Valid(entry.Name)&&SelectedNames.Count>=10){entry.Selected=false;Say("本轮已有10个板块；新名称已保存，取消其他选择后可选入本轮。");}entry.Name=value;var cell=FindCell(entry);if(cell!=null){cell.Value=value;PaintCell(cell);}Notify();return true;
  }
  public void Edit(BoardEntry entry){if(entry==null||!Enabled)return;var cell=FindCell(entry);if(cell==null)return;Grid.CurrentCell=cell;Grid.Focus();Grid.BeginEdit(true);}
  void NameEdited(object sender,DataGridViewCellEventArgs e){
   if(rebuilding)return;var cell=Cell(e.RowIndex,e.ColumnIndex);var entry=cell==null?null:cell.Tag as BoardEntry;if(entry==null)return;string value=Convert.ToString(cell.Value);if(entry.Name.Length==0&&String.IsNullOrWhiteSpace(value))return;lastEditValid=Rename(entry,value);cell.Value=entry.Name;PaintCell(cell);
  }
 }
}
