/**
 * @module node-opcua-address-space
 */
import * as async from "async";
import * as _ from "underscore";

import { assert } from "node-opcua-assert";
import { DataValue } from "node-opcua-data-value";
import {
    resolveNodeId
} from "node-opcua-nodeid";
import {
    ArgumentDefinition,
    BrowseDescriptionLike, CallMethodRequestLike, getArgumentDefinitionHelper,
    IBasicSession, MethodId,
    ReadValueIdLike,
    ResponseCallback
} from "node-opcua-pseudo-session";
import {
    BrowseDescription,
    BrowseDescriptionOptions,
    BrowseRequest,
    BrowseResponse,
    BrowseNextResponse,
    BrowseResult
} from "node-opcua-service-browse";
import {
    CallMethodRequest,
    CallMethodResult,
    CallMethodResultOptions
} from "node-opcua-service-call";
import {
    BrowsePath,
    BrowsePathResult
} from "node-opcua-service-translate-browse-path";
import {
    StatusCodes
} from "node-opcua-status-code";

import { AddressSpace } from "./address_space_ts";
import { callMethodHelper } from "./helpers/call_helpers";
import { IServerBase, ISessionBase, SessionContext } from "./session_context";
import { ContinuationPointManager } from "./continuation_points/continuation_point_manager";
import { MessageSecurityMode } from "node-opcua-types";
/**
 * Pseudo session is an helper object that exposes the same async methods
 * than the ClientSession. It can be used on a server address space.
 *
 * Code reused !
 * The primary benefit of this object  is that its makes advanced OPCUA
 * operations that uses browse, translate, read, write etc similar
 * whether we work inside a server or through a client session.
 *
 * @param addressSpace {AddressSpace}
 * @constructor
 */
export class PseudoSession implements IBasicSession {

    public server: IServerBase;
    public session: ISessionBase;
    public requestedMaxReferencesPerNode: number = 0;

    private readonly addressSpace: AddressSpace;
    private readonly continuationPointManager: ContinuationPointManager;

    constructor(addressSpace: AddressSpace, server?: IServerBase, session?: ISessionBase) {
        this.addressSpace = addressSpace;
        this.server = server || {};
        this.session = session || { 
            channel: { 
                clientCertificate: null,
                securityMode: MessageSecurityMode.None,
                securityPolicy: "http://opcfoundation.org/UA/SecurityPolicy#None" // SecurityPolicy.None 
            }
        };
        this.continuationPointManager = new ContinuationPointManager();
    }

    public browse(nodeToBrowse: BrowseDescriptionLike, callback: ResponseCallback<BrowseResult>): void;
    public browse(nodesToBrowse: BrowseDescriptionLike[], callback: ResponseCallback<BrowseResult[]>): void;
    public browse(nodeToBrowse: BrowseDescriptionLike): Promise<BrowseResult>;
    public browse(nodesToBrowse: BrowseDescriptionLike[]): Promise<BrowseResult[]>;
    public browse(nodesToBrowse: BrowseDescriptionLike | BrowseDescriptionLike[], callback?: ResponseCallback<any>): any {

        setImmediate(()=>{
            const isArray = _.isArray(nodesToBrowse);
            if (!isArray) {
                nodesToBrowse = [nodesToBrowse as BrowseDescriptionLike];
            }
            let results: BrowseResult[] = [];
            for (let browseDescription of nodesToBrowse as any[]) {
                browseDescription.referenceTypeId = resolveNodeId(browseDescription.referenceTypeId);
                browseDescription = new BrowseDescription(browseDescription);
                const nodeId = resolveNodeId(browseDescription.nodeId);
                const r = this.addressSpace.browseSingleNode(nodeId, browseDescription);
                results.push(r);
            }

            // handle continuation points
            results = results.map((result: BrowseResult) => {
                assert(!result.continuationPoint);
                const truncatedResult = this.continuationPointManager.register(
                this.requestedMaxReferencesPerNode,
                result.references || []
                );
                assert(truncatedResult.statusCode === StatusCodes.Good);
                truncatedResult.statusCode = result.statusCode;
                return new BrowseResult(truncatedResult);
            });


            callback!(null, isArray ? results : results[0]);
            
        });
    }

    public read(nodeToRead: ReadValueIdLike, callback: ResponseCallback<DataValue>): void;
    public read(nodesToRead: ReadValueIdLike[], callback: ResponseCallback<DataValue[]>): void;
    public read(nodeToRead: ReadValueIdLike): Promise<DataValue>;
    public read(nodesToRead: ReadValueIdLike[]): Promise<DataValue[]>;
    public read(nodesToRead: any, callback?: ResponseCallback<any>): any {

        const isArray = _.isArray(nodesToRead);
        if (!isArray) {
            nodesToRead = [nodesToRead];
        }

        setImmediate(()=> {


            // xx const context = new SessionContext({ session: null });
            const dataValues = nodesToRead.map((nodeToRead: ReadValueIdLike) => {

                assert(!!nodeToRead.nodeId, "expecting a nodeId");
                assert(!!nodeToRead.attributeId, "expecting a attributeId");

                const nodeId = nodeToRead.nodeId!;
                const attributeId = nodeToRead.attributeId!;
                const indexRange = nodeToRead.indexRange;
                const dataEncoding = nodeToRead.dataEncoding;
                const obj = this.addressSpace.findNode(nodeId);
                if (!obj) {
                    return new DataValue({ statusCode: StatusCodes.BadNodeIdUnknown });
                }
                const context = SessionContext.defaultContext;
                const dataValue = obj.readAttribute(context, attributeId, indexRange, dataEncoding);
                return dataValue;
            });

            callback!(null, isArray ? dataValues : dataValues[0]);
        });
    }

    public browseNext(
      continuationPoint: Buffer,
      releaseContinuationPoints: boolean,
      callback: ResponseCallback<BrowseResult>): void;

    public browseNext(
      continuationPoints: Buffer[],
      releaseContinuationPoints: boolean,
      callback: ResponseCallback<BrowseResult[]>): void;

    public browseNext(
      continuationPoint: Buffer,
      releaseContinuationPoints: boolean
    ): Promise<BrowseResult>;

    public browseNext(
      continuationPoints: Buffer[],
      releaseContinuationPoints: boolean
    ): Promise<BrowseResult[]>;
    public browseNext(
        continuationPoints: Buffer | Buffer[],
        releaseContinuationPoints: boolean,
        callback?: any
    ): any {

        setImmediate(()=>{ 

            if (continuationPoints instanceof Buffer) {
                return this.browseNext([continuationPoints],releaseContinuationPoints,
                    (err, results) => {
                    if (err) { return callback!(err);}
                    callback!(null, results![0]);
                });
                return;
            }
            const session = this;
            let results: any;
            if (releaseContinuationPoints) {
                // releaseContinuationPoints = TRUE
                //   passed continuationPoints shall be reset to free resources in
                //   the Server. The continuation points are released and the results
                //   and diagnosticInfos arrays are empty.
                results = continuationPoints.map((continuationPoint: any) => {
                    return session.continuationPointManager.cancel(continuationPoint);
                });

            } else {
                // let extract data from continuation points

                // releaseContinuationPoints = FALSE
                //   passed continuationPoints shall be used to get the next set of
                //   browse information.
                results = continuationPoints.map((continuationPoint: any) => {
                    return session.continuationPointManager.getNext(continuationPoint);
                });
            }
            results = results.map((r: any) => new BrowseResult(r));

            callback!(null, results);
        });

    }

    // call service ----------------------------------------------------------------------------------------------------
    public call(
      methodToCall: CallMethodRequestLike,
      callback: ResponseCallback<CallMethodResult>
    ): void;
    public call(
      methodsToCall: CallMethodRequestLike[],
      callback: ResponseCallback<CallMethodResult[]>
    ): void;
    public call(
      methodToCall: CallMethodRequestLike
    ): Promise<CallMethodResult>;
    public call(
      methodsToCall: CallMethodRequestLike[]
    ): Promise<CallMethodResult[]>;
    public call(
      methodsToCall: CallMethodRequestLike | CallMethodRequestLike[],
      callback?: ResponseCallback<any>
    ): any {

        const isArray = _.isArray(methodsToCall);
        if (!isArray) {
            methodsToCall = [methodsToCall as CallMethodRequestLike];
        }

        async.map(methodsToCall as CallMethodRequestLike[],
          (methodToCall, innerCallback: (err: Error | null, result?: CallMethodResult) => void) => {

              const callMethodRequest = new CallMethodRequest(methodToCall);

              callMethodHelper(
                this.server, this.session, this.addressSpace, callMethodRequest,
                (err: Error | null, result?: CallMethodResultOptions) => {

                    let callMethodResult: CallMethodResult;
                    if (err) {
                        callMethodResult = new CallMethodResult({
                            statusCode: StatusCodes.BadInternalError
                        });
                    } else {
                        callMethodResult = new CallMethodResult(result);
                    }
                    innerCallback(null, callMethodResult);
                });

          }, (err?: Error | null, callMethodResults?: any) => {
              callback!(null, isArray ? callMethodResults! : callMethodResults![0]);
          });
    }

    public getArgumentDefinition(
      methodId: MethodId
    ): Promise<ArgumentDefinition>;
    public getArgumentDefinition(
      methodId: MethodId, callback: ResponseCallback<ArgumentDefinition>
    ): void;
    public getArgumentDefinition(methodId: MethodId, callback?: ResponseCallback<ArgumentDefinition>): any {
        return getArgumentDefinitionHelper(this, methodId, callback!);
    }

    public translateBrowsePath(browsePaths: BrowsePath[], callback: ResponseCallback<BrowsePathResult[]>): void;
    public translateBrowsePath(browsePath: BrowsePath, callback: ResponseCallback<BrowsePathResult>): void;
    public translateBrowsePath(browsePath: BrowsePath): Promise<BrowsePathResult>;
    public translateBrowsePath(browsePaths: BrowsePath[]): Promise<BrowsePathResult[]>;
    public translateBrowsePath(
      browsePaths: BrowsePath[] | BrowsePath,
      callback?: any
    ): any {

        const isArray = _.isArray(browsePaths);
        if (!isArray) {
            browsePaths = [browsePaths as BrowsePath];
        }
        // xx const context = new SessionContext({ session: null });
        const browsePathResults = (browsePaths as BrowsePath[]).map((browsePath: BrowsePath) => {
            return this.addressSpace.browsePath(browsePath);
        });
        callback!(null, isArray ? browsePathResults : browsePathResults[0]);
    }
}

// tslint:disable:no-var-requires
// tslint:disable:max-line-length
const thenify = require("thenify");
PseudoSession.prototype.read = thenify.withCallback(PseudoSession.prototype.read);
PseudoSession.prototype.browse = thenify.withCallback(PseudoSession.prototype.browse);
PseudoSession.prototype.browseNext = thenify.withCallback(PseudoSession.prototype.browseNext);
PseudoSession.prototype.getArgumentDefinition = thenify.withCallback(PseudoSession.prototype.getArgumentDefinition);
PseudoSession.prototype.call = thenify.withCallback(PseudoSession.prototype.call);
PseudoSession.prototype.translateBrowsePath = thenify.withCallback(PseudoSession.prototype.translateBrowsePath);
