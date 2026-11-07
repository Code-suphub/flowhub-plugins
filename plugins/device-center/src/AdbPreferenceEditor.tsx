import {useId,useState,type KeyboardEvent} from 'react';
import {Button,Input,NumberInput} from '@flowhub/plugin-common/react';

type Props = {
  kind: 'alias' | 'threshold';
  saved: string;
  disabled?: boolean;
  save: (value: string) => Promise<void>;
};

export function AdbPreferenceEditor({kind,saved,disabled,save}:Props) {
  const id=useId();
  const [draft,setDraft]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [failed,setFailed]=useState(false);
  const alias=kind==='alias';
  const value=draft??saved;

  async function submit() {
    const next=value.trim();
    if(disabled||busy||next===saved)return;
    if(!alias&&(!/^\d{1,3}$/.test(next)||Number(next)>100)){
      setFailed(true);
      setMessage('请输入 0 到 100 的整数');
      return;
    }
    setBusy(true);
    setFailed(false);
    setMessage('');
    try {
      await save(next);
      setDraft(null);
      setMessage('已保存');
    } catch(error) {
      setFailed(true);
      setMessage(error instanceof Error?error.message:'保存失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  function change(next:string) {
    setDraft(next);
    setMessage('');
  }
  function onInputKeyDown(event:KeyboardEvent<HTMLInputElement>) {
    if(event.key==='Enter'&&!event.nativeEvent.isComposing){
      event.preventDefault();
      void submit();
    }
  }
  const inputProps={
    id,disabled:disabled||busy,value,'aria-describedby':id+'-help',
    onChange:(event:React.ChangeEvent<HTMLInputElement>)=>change(event.target.value),
    onKeyDown:onInputKeyDown
  };

  // The host's opaque iframe disallows native form submission.
  return <div className="dc-adb-preference">
    <label htmlFor={id}>{alias?'设备别名':'低电量阈值（%）'}</label>
    <div className="dc-adb-preference-controls">
      {alias?<Input {...inputProps} className="dc-input" type="text" maxLength={40} placeholder="例如：测试机"/>
        :<NumberInput {...inputProps} data-number-control="true" containerClassName="dc-adb-threshold"
          min={0} max={100} step={1} onValueChange={change}/>}
      <Button className="dc-button" disabled={disabled||busy||value.trim()===saved} onClick={()=>void submit()}>
        {busy?'保存中…':'保存'}
      </Button>
    </div>
    <p id={id+'-help'}>{alias?'按当前 ADB 连接保存，留空可恢复原名。':'低于此值时标红，填 0 关闭提醒。'}</p>
    {message?<p className={failed?'dc-adb-save-error':''} role={failed?'alert':'status'}>{message}</p>:null}
  </div>;
}
