// Corresponds to https://github.com/hastic/hastic-server/blob/master/server/src/models/analytic_unit.ts

import { AnalyticService } from '../services/analytic_service'

import {
  AnalyticUnitId, AnalyticUnit,
  AnalyticUnitsSet, AnalyticSegment, AnalyticSegmentsSearcher, AnalyticSegmentPair
} from '../models/analytic_unit';
import { MetricExpanded } from '../models/metric';
import { DatasourceRequest } from '../models/datasource';
import { Segment, SegmentId } from '../models/segment';
import { SegmentsSet } from '../models/segment_set';
import { SegmentArray } from '../models/segment_array';

import { Emitter } from 'grafana/app/core/utils/emitter'

import _ from 'lodash';


export const REGION_FILL_ALPHA = 0.7;
export const REGION_STROKE_ALPHA = 0.9;
export const REGION_DELETE_COLOR_LIGHT = '#d1d1d1';
export const REGION_DELETE_COLOR_DARK = 'white';


export class AnalyticController {

  private _analyticUnitsSet: AnalyticUnitsSet;
  private _selectedAnalyticUnitKey: AnalyticUnitId = null;

  private _labelingDataAddedSegments: SegmentsSet<AnalyticSegment>;
  private _labelingDataDeletedSegments: SegmentsSet<AnalyticSegment>;
  private _newAnalyticUnit: AnalyticUnit = null;
  private _creatingNewAnalyticType: boolean = false;
  private _savingNewAnalyticUnit: boolean = false;
  private _tempIdCounted = -1;
  private _graphLocked = false;

  private _statusRunners: Set<AnalyticUnitId> = new Set<AnalyticUnitId>();


  constructor(private _panelObject: any, private _analyticService: AnalyticService, private _emitter: Emitter) {
    if(_panelObject.anomalyTypes === undefined) {
      _panelObject.anomalyTypes = [];
    }
    this._labelingDataAddedSegments = new SegmentArray<AnalyticSegment>();
    this._labelingDataDeletedSegments = new SegmentArray<AnalyticSegment>();
    this._analyticUnitsSet = new AnalyticUnitsSet(this._panelObject.anomalyTypes);
    this.analyticUnits.forEach(a => this.runEnabledWaiter(a));
  }

  getSegmentsSearcher(): AnalyticSegmentsSearcher {
    return this._segmentsSearcher.bind(this);
  }

  private _segmentsSearcher(point: number, rangeDist: number): AnalyticSegmentPair[] {
    var result: AnalyticSegmentPair[] = [];
    this._analyticUnitsSet.items.forEach(at => {
      var segs = at.segments.findSegments(point, rangeDist);
      segs.forEach(s => {
        result.push({ anomalyType: at, segment: s });
      })
    })
    return result;
  }

  createNew() {
    this._newAnalyticUnit = new AnalyticUnit();
    this._creatingNewAnalyticType = true;
    this._savingNewAnalyticUnit = false;
  }

  async saveNew(metricExpanded: MetricExpanded, datasourceRequest: DatasourceRequest, panelId: number) {
    this._savingNewAnalyticUnit = true;
    this._newAnalyticUnit.id = await this._analyticService.postNewItem(
      metricExpanded, datasourceRequest, this._newAnalyticUnit, panelId
    );
    this._analyticUnitsSet.addItem(this._newAnalyticUnit);
    this._creatingNewAnalyticType = false;
    this._savingNewAnalyticUnit = false;
    this.runEnabledWaiter(this._newAnalyticUnit);
    this._runStatusWaiter(this._newAnalyticUnit);
  }

  get creatingNew() { return this._creatingNewAnalyticType; }
  get saving() { return this._savingNewAnalyticUnit; }
  get newAnalyticUnit(): AnalyticUnit { return this._newAnalyticUnit; }

  get graphLocked() { return this._graphLocked; }
  set graphLocked(value) { this._graphLocked = value; }

  get labelingAnomaly(): AnalyticUnit {
    if(this._selectedAnalyticUnitKey === null) {
      return null;
    }
    return this._analyticUnitsSet.byId(this._selectedAnalyticUnitKey);
  }

  async toggleAnomalyTypeLabelingMode(key: AnalyticUnitId) {
    if(this.labelingAnomaly && this.labelingAnomaly.saving) {
      throw new Error('Can`t toggel during saving');
    }
    if(this._selectedAnalyticUnitKey === key) {
      return this.disableLabeling();
    }
    await this.disableLabeling();
    this._selectedAnalyticUnitKey = key;
    this.labelingAnomaly.selected = true;
    this.toggleVisibility(key, true);
  }

  async disableLabeling() {
    if(this._selectedAnalyticUnitKey === null) {
      return;
    }
    this.labelingAnomaly.saving = true;
    var newIds = await this._saveLabelingData();
    this._labelingDataAddedSegments.getSegments().forEach((s, i) => {
      this.labelingAnomaly.segments.updateId(s.id, newIds[i]);
    })
    this.labelingAnomaly.saving = false;
    
    var anomaly = this.labelingAnomaly;
    this.dropLabeling();
    this._runStatusWaiter(anomaly);
  }

  undoLabeling() {
    this._labelingDataAddedSegments.getSegments().forEach(s => {
      this.labelingAnomaly.segments.remove(s.id);
    });
    this._labelingDataDeletedSegments.getSegments().forEach(s => {
      this.labelingAnomaly.segments.addSegment(s);
    });
    this.dropLabeling();
  }

  dropLabeling() {
    this._labelingDataAddedSegments.clear();
    this._labelingDataDeletedSegments.clear();
    this.labelingAnomaly.selected = false;
    this._selectedAnalyticUnitKey = null;
    this._tempIdCounted = -1;
  }

  get labelingMode(): boolean {
    return this._selectedAnalyticUnitKey !== null;
  }

  get labelingDeleteMode(): boolean {
    if(!this.labelingMode) {
      return false;
    }
    return this.labelingAnomaly.deleteMode;
  }

  addLabelSegment(segment: Segment) {
    var asegment = this.labelingAnomaly.addLabeledSegment(segment);
    this._labelingDataAddedSegments.addSegment(asegment);
  }

  get analyticUnits(): AnalyticUnit[] {
    return this._analyticUnitsSet.items;
  }

  onAnomalyColorChange(key: AnalyticUnitId, value) {
    this._analyticUnitsSet.byId(key).color = value;
  }

  fetchAnomalyTypesStatuses() {
    this.analyticUnits.forEach(a => this._runStatusWaiter(a));
  }

  async fetchAnomalyTypesSegments(from: number, to: number) {
    if(!_.isNumber(+from)) {
      throw new Error('from isn`t number');
    }
    if(!_.isNumber(+to)) {
      throw new Error('to isn`t number');
    }
    var tasks = this.analyticUnits.map(a => this.fetchSegments(a, from, to));
    return Promise.all(tasks);
  }

  async fetchSegments(anomalyType: AnalyticUnit, from: number, to: number): Promise<void> {
    if(!_.isNumber(+from)) {
      throw new Error('from isn`t number');
    }
    if(!_.isNumber(+to)) {
      throw new Error('to isn`t number');
    }
    var allSegmentsList = await this._analyticService.getSegments(anomalyType.id, from, to);
    var allSegmentsSet = new SegmentArray(allSegmentsList);
    if(anomalyType.selected) {
      this._labelingDataAddedSegments.getSegments().forEach(s => allSegmentsSet.addSegment(s));
      this._labelingDataDeletedSegments.getSegments().forEach(s => allSegmentsSet.remove(s.id));
    }
    anomalyType.segments = allSegmentsSet;
  }

  private async _saveLabelingData(): Promise<SegmentId[]> {
    var anomaly = this.labelingAnomaly;
    if(anomaly === null) {
      throw new Error('anomaly is not selected');
    }

    if(
      this._labelingDataAddedSegments.length === 0 &&
      this._labelingDataDeletedSegments.length === 0
    ) {
      return [];
    }

    return this._analyticService.updateSegments(
      anomaly.id, this._labelingDataAddedSegments, this._labelingDataDeletedSegments
    );
  }

  // TODO: move to renderer
  updateFlotEvents(isEditMode, options) {
    if(options.grid.markings === undefined) {
      options.markings = [];
    }

    for(var i = 0; i < this.analyticUnits.length; i++) {
      var anomalyType = this.analyticUnits[i];
      var borderColor = addAlphaToRGB(anomalyType.color, REGION_STROKE_ALPHA);
      var fillColor = addAlphaToRGB(anomalyType.color, REGION_FILL_ALPHA);
      var segments = anomalyType.segments.getSegments();
      if(!anomalyType.visible) {
        continue;
      }
      if(isEditMode && this.labelingMode) {
        if(anomalyType.selected) {
          borderColor = addAlphaToRGB(borderColor, 0.7);
          fillColor = addAlphaToRGB(borderColor, 0.7);
        } else {
          continue;
        }
      }

      var rangeDist = +options.xaxis.max - +options.xaxis.min;
      segments.forEach(s => {
        var expanded = s.expandDist(rangeDist, 0.01);
        options.grid.markings.push({
          xaxis: { from: expanded.from, to: expanded.to },
          color: fillColor
        });
        options.grid.markings.push({
          xaxis: { from: expanded.from, to: expanded.from },
          color: borderColor
        });
        options.grid.markings.push({
          xaxis: { from: expanded.to, to: expanded.to },
          color: borderColor
        });
      });
    }

  }

  deleteLabelingAnomalySegmentsInRange(from: number, to: number) {
    var allRemovedSegs = this.labelingAnomaly.removeSegmentsInRange(from, to);
    allRemovedSegs.forEach(s => {
      if(!this._labelingDataAddedSegments.has(s.id)) {
        this._labelingDataDeletedSegments.addSegment(s);
      }
    });
    this._labelingDataAddedSegments.removeInRange(from, to);
  }

  toggleDeleteMode() {
    if(!this.labelingMode) {
      throw new Error('Cant enter delete mode is labeling mode disabled');
    }
    this.labelingAnomaly.deleteMode = !this.labelingAnomaly.deleteMode;
  }

  removeAnomalyType(key) {
    if(key === this._selectedAnalyticUnitKey) {
      this.dropLabeling();
    }
    this._analyticUnitsSet.removeItem(key);
  }

  private async _runStatusWaiter(anomalyType: AnalyticUnit) {
    if(anomalyType === undefined || anomalyType === null) {
      throw new Error('anomalyType not defined');
    }

    if(anomalyType.id === undefined) {
      throw new Error('anomalyType.id is undefined');
    }

    if(this._statusRunners.has(anomalyType.id)) {
      return;
    }

    this._statusRunners.add(anomalyType.id);

    var statusGenerator = this._analyticService.getStatusGenerator(
      anomalyType.id, 1000
    );

    for await (const data of statusGenerator) {
      let status = data.status;
      let error = data.errorMessage;
      if(anomalyType.status !== status) {
        anomalyType.status = status;
        if(error !== undefined) {
          anomalyType.error = error;
        }
        this._emitter.emit('anomaly-type-status-change', anomalyType);
      }
      if(!anomalyType.isActiveStatus) {
        break;
      }
    }

    this._statusRunners.delete(anomalyType.id);
  }

  async runEnabledWaiter(anomalyType: AnalyticUnit) {
    var enabled = await this._analyticService.getAlertEnabled(anomalyType.id);
    if(anomalyType.alertEnabled !== enabled) {
      anomalyType.alertEnabled = enabled;
      this._emitter.emit('anomaly-type-alert-change', anomalyType);
    }
  }

  async toggleAlertEnabled(anomalyType: AnalyticUnit) {
    var enabled = anomalyType.alertEnabled;
    anomalyType.alertEnabled = undefined;
    await this._analyticService.setAlertEnabled(anomalyType.id, enabled);
    anomalyType.alertEnabled = enabled;
    this._emitter.emit('anomaly-type-alert-change', anomalyType);
  }

  public getIdForNewLabelSegment() {
    this._tempIdCounted--;
    return this._tempIdCounted;
  }

  public toggleVisibility(key: AnalyticUnitId, value?: boolean) {
    var anomaly = this._analyticUnitsSet.byId(key);
    if(value !== undefined) {
      anomaly.visible = value;
    } else {
      anomaly.visible = !anomaly.visible;
    }
  }

}

function addAlphaToRGB(colorString: string, alpha: number): string {
  let color = tinycolor(colorString);
  if (color.isValid()) {
    color.setAlpha(color.getAlpha() * alpha);
    return color.toRgbString();
  } else {
    return colorString;
  }
}
