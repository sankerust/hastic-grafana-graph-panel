import { Segment, SegmentId } from '../models/segment';
import { MetricExpanded } from '../models/metric';
import { DatasourceRequest } from '../models/datasource';
import { SegmentsSet } from '../models/segment_set';
import { AnalyticUnitId, AnalyticUnit, AnalyticSegment } from '../models/analytic_unit';

import { BackendSrv } from 'grafana/app/core/services/backend_srv';



export class AnalyticService {
  constructor(private _backendURL: string, private _backendSrv: BackendSrv) {
  }

  async postNewItem(
    metric: MetricExpanded, datasourceRequest: DatasourceRequest, 
    newItem: AnalyticUnit, panelId: number
  ) {
    return this._backendSrv.post(
      this._backendURL + '/analyticUnits', 
      {
        name: newItem.name,
        metric: metric.toJSON(),
        panelUrl: window.location.origin + window.location.pathname + `?panelId=${panelId}&fullscreen`,
        datasource: datasourceRequest,
        pattern: newItem.pattern
      }
    )
  };

  async isBackendOk(): Promise<boolean> {
    try {
      var data = await this._backendSrv.get(this._backendURL);
      return true;
    } catch(e) {
      return false;
    }
  }
   
  async updateSegments(
    key: AnalyticUnitId, addedSegments: SegmentsSet<Segment>, removedSegments: SegmentsSet<Segment>
  ): Promise<SegmentId[]> {

    const getJSONs = (segs: SegmentsSet<Segment>) => segs.getSegments().map(segment => ({
      "start": segment.from,
      "finish": segment.to
    }));

    var payload = {
      name: key,
      addedSegments: getJSONs(addedSegments),
      removedSegments: removedSegments.getSegments().map(s => s.id)
    }

    var data = await this._backendSrv.patch(this._backendURL + '/segments', payload);
    if(data.addedIds === undefined) {
      throw new Error('Server didn`t send added_ids');
    }

    return data.addedIds as SegmentId[];
  }

  async getSegments(id: AnalyticUnitId, from?: number, to?: number): Promise<AnalyticSegment[]> {
    var payload: any = { id };
    if(from !== undefined) {
      payload['from'] = from;
    }
    if(to !== undefined) {
      payload['to'] = to;
    }
    var data = await this._backendSrv.get(
      this._backendURL + '/segments',
      payload
    );
    if(data.segments === undefined) {
      throw new Error('Server didn`t return segments array');
    }
    var segments = data.segments as { id: number, start: number, finish: number, labeled: boolean }[];
    return segments.map(s => new AnalyticSegment(s.labeled, s.id, s.start, s.finish));
  }

  async * getAnomalyTypeStatusGenerator(key: AnalyticUnitId, duration: number) {
    let statusCheck = async () => {
      var data = await this._backendSrv.get(
        this._backendURL + '/analyticUnits/status', { name: key }
      );
      return data;
    }

    let timeout = async () => new Promise(
      resolve => setTimeout(resolve, duration)
    );

    while(true) {
      yield await statusCheck();
      await timeout();
    }
    
  }

  async getAlertEnabled(id: AnalyticUnitId): Promise<boolean> {
    var data = await this._backendSrv.get(
      this._backendURL + '/alerts', { id }
    );
    return data.enable as boolean;

  }

  async setAlertEnabled(id: AnalyticUnitId, enabled: boolean): Promise<void> {
    return this._backendSrv.post(
      this._backendURL + '/alerts', { id, enabled }
    );
  }

}