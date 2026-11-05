import {Button} from '@flowhub/plugin-common/react';
import type {NetworkSummary,Selection,VolumeDetail} from './api';
import {formatDate,statusLabels} from './model';
import {resourceKey} from './useResourceNavigation';

export function ResourceDetails({kind,info,onSelect,onRemove,disabled}:{kind:'volume'|'network';info:VolumeDetail|NetworkSummary;onSelect(selection:Selection,origin?:HTMLElement):void;onRemove():void;disabled:boolean}) {
  const volume=kind==='volume'?info as VolumeDetail:null,network=kind==='network'?info as NetworkSummary:null;
  const reason=info.containers.length?'仍被容器引用，包括已停止容器。':!info.removable?kind==='volume'?'仅能删除身份信息完整的本地 local 卷。':'默认网络及非本地 bridge 网络受保护。':'';
  return <div className="docker-overview-content">
    <div className="docker-actions"><Button variant="danger" size="sm" disabled={disabled || Boolean(reason)} onClick={onRemove}>删除{kind==='volume'?'卷':'网络'}</Button>{reason?<p className="docker-image-delete-reason">{reason}</p>:null}</div>
    <dl className="docker-detail-grid"><dt>名称</dt><dd>{info.name}</dd><dt>驱动 / 范围</dt><dd>{info.driver} / {info.scope}</dd><dt>创建时间</dt><dd>{formatDate(info.createdAt,'未提供创建时间')}</dd><dt>Compose 项目</dt><dd>{info.project || '—'}</dd>
      {volume?<><dt>引擎内路径</dt><dd>{volume.mountpoint || '未提供'}</dd></>:network?<><dt>网络 ID</dt><dd>{network.id}</dd><dt>网络模式</dt><dd>{network.internal?'内部网络':'普通网络'} · IPv6 {network.ipv6?'已启用':'未启用'}</dd><dt>子网 / 网关</dt><dd>{network.ipam.length?network.ipam.map(row=>(row.subnet || '未提供子网')+' / '+(row.gateway || '未提供网关')).join('\n'):'未配置'}</dd></>:null}
    </dl><h3>引用容器 · {info.containers.length}</h3>
    {info.containers.length?info.containers.map(row=><button type="button" className="docker-member-row" key={row.id} data-docker-select={resourceKey({kind:'container',id:row.id})} onClick={event=>onSelect({kind:'container',id:row.id},event.currentTarget)}><span>{row.name}<small>{row.project || '独立容器'}{row.destination?' · '+row.destination+(row.readOnly?'（只读）':''):''}</small></span><small>{statusLabels[row.state] || row.state} ↗</small></button>):<p className="docker-muted">{kind==='volume'?'当前没有容器引用。未引用不代表卷内没有数据。':'当前没有容器连接。'}</p>}
  </div>;
}
