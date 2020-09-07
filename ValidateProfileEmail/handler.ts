import * as crypto from "crypto";

import * as express from "express";

import { isLeft } from "fp-ts/lib/Either";
import { isNone } from "fp-ts/lib/Option";

import * as t from "io-ts";

import { Context } from "@azure/functions";
import { TableService } from "azure-storage";

import { readableReport } from "italia-ts-commons/lib/reporters";
import {
  IResponseErrorValidation,
  IResponseSeeOtherRedirect,
  ResponseSeeOtherRedirect
} from "italia-ts-commons/lib/responses";
import { PatternString } from "italia-ts-commons/lib/strings";

import { RequiredQueryParamMiddleware } from "io-functions-commons/dist/src/utils/middlewares/required_query_param";

import { ValidationTokenEntity } from "io-functions-commons/dist/src/entities/validation_token";
import { ProfileModel } from "io-functions-commons/dist/src/models/profile";
import { retrieveTableEntity } from "io-functions-commons/dist/src/utils/azure_storage";
import { ContextMiddleware } from "io-functions-commons/dist/src/utils/middlewares/context_middleware";
import {
  withRequestMiddlewares,
  wrapRequestHandler
} from "io-functions-commons/dist/src/utils/request_middleware";
import { ValidUrl } from "italia-ts-commons/lib/url";

// Tokens are generated by CreateValidationTokenActivity function inside the
// io-functions-app project (https://github.com/pagopa/io-functions-app)
// A token is in the following format:
// [tokenId ULID] + ":" + [validatorHash crypto.randomBytes(12)]
export const TokenQueryParam = PatternString(
  "^[A-Za-z0-9]{26}:[A-Fa-f0-9]{24}$"
);
export type TokenQueryParam = t.TypeOf<typeof TokenQueryParam>;

type IValidateProfileEmailHandler = (
  context: Context,
  token: TokenQueryParam
) => Promise<IResponseSeeOtherRedirect | IResponseErrorValidation>;

// Used in the callback
export enum ValidationErrors {
  GENERIC_ERROR = "GENERIC_ERROR",
  INVALID_TOKEN = "INVALID_TOKEN",
  TOKEN_EXPIRED = "TOKEN_EXPIRED"
}

/**
 * Returns a ValidUrl that represents a successful validation
 */
function validationSuccessUrl(validationCallbackUrl: ValidUrl): ValidUrl {
  return {
    href: `${validationCallbackUrl.href}?result=success&time=${Date.now()}`
  };
}

/**
 * Returns a ValidUrl that represents a failed validation
 */
function validationFailureUrl(
  validationCallbackUrl: ValidUrl,
  error: keyof typeof ValidationErrors,
  timeStampGenerator: () => number
): ValidUrl {
  return {
    href: `${
      validationCallbackUrl.href
    }?result=failure&error=${error}&time=${timeStampGenerator()}`
  };
}

const TokenQueryParamMiddleware = RequiredQueryParamMiddleware(
  "token",
  TokenQueryParam
);

// tslint:disable-next-line: cognitive-complexity
export function ValidateProfileEmailHandler(
  tableService: TableService,
  validationTokensTableName: string,
  profileModel: ProfileModel,
  validationCallbackUrl: ValidUrl,
  timeStampGenerator: () => number
): IValidateProfileEmailHandler {
  return async (context, token) => {
    const logPrefix = `ValidateProfileEmail|TOKEN=${token}`;
    const vFailureUrl = (error: keyof typeof ValidationErrors) =>
      validationFailureUrl(validationCallbackUrl, error, timeStampGenerator);

    // STEP 1: Find and verify validation token

    // A token is in the following format:
    // [tokenId ULID] + ":" + [validatorHash crypto.randomBytes(12)]
    // Split the token to get tokenId and validatorHash
    const [tokenId, validator] = token.split(":");
    const validatorHash = crypto
      .createHash("sha256")
      .update(validator)
      .digest("hex");

    // Retrieve the entity from the table storage
    const errorOrMaybeTableEntity = await retrieveTableEntity(
      tableService,
      validationTokensTableName,
      tokenId,
      validatorHash
    );

    if (isLeft(errorOrMaybeTableEntity)) {
      context.log.error(
        `${logPrefix}|Error searching validation token|ERROR=${errorOrMaybeTableEntity.value.message}`
      );
      return ResponseSeeOtherRedirect(
        vFailureUrl(ValidationErrors.GENERIC_ERROR)
      );
    }

    const maybeTokenEntity = errorOrMaybeTableEntity.value;

    if (isNone(maybeTokenEntity)) {
      context.log.error(`${logPrefix}|Validation token not found`);
      return ResponseSeeOtherRedirect(
        vFailureUrl(ValidationErrors.INVALID_TOKEN)
      );
    }

    // Check if the entity is a ValidationTokenEntity
    const errorOrValidationTokenEntity = ValidationTokenEntity.decode(
      maybeTokenEntity.value
    );

    if (isLeft(errorOrValidationTokenEntity)) {
      context.log.error(
        `${logPrefix}|Validation token can't be decoded|ERROR=${readableReport(
          errorOrValidationTokenEntity.value
        )}`
      );
      return ResponseSeeOtherRedirect(
        vFailureUrl(ValidationErrors.INVALID_TOKEN)
      );
    }

    const validationTokenEntity = errorOrValidationTokenEntity.value;
    const {
      Email: email,
      InvalidAfter: invalidAfter,
      FiscalCode: fiscalCode
    } = validationTokenEntity;

    // Check if the token is expired
    if (Date.now() > invalidAfter.getTime()) {
      context.log.error(
        `${logPrefix}|Token expired|EXPIRED_AT=${invalidAfter}`
      );
      return ResponseSeeOtherRedirect(
        vFailureUrl(ValidationErrors.TOKEN_EXPIRED)
      );
    }

    // STEP 2: Find the profile
    const errorOrMaybeExistingProfile = await profileModel
      .findLastVersionByModelId([fiscalCode])
      .run();

    if (isLeft(errorOrMaybeExistingProfile)) {
      context.log.error(
        `${logPrefix}|Error searching the profile|ERROR=${errorOrMaybeExistingProfile.value}`
      );
      return ResponseSeeOtherRedirect(
        vFailureUrl(ValidationErrors.GENERIC_ERROR)
      );
    }

    const maybeExistingProfile = errorOrMaybeExistingProfile.value;
    if (isNone(maybeExistingProfile)) {
      context.log.error(`${logPrefix}|Profile not found`);
      return ResponseSeeOtherRedirect(
        vFailureUrl(ValidationErrors.GENERIC_ERROR)
      );
    }

    const existingProfile = maybeExistingProfile.value;

    // Check if the email in the profile is the same of the one in the validation token
    if (existingProfile.email !== email) {
      context.log.error(`${logPrefix}|Email mismatch`);
      return ResponseSeeOtherRedirect(
        vFailureUrl(ValidationErrors.INVALID_TOKEN)
      );
    }

    // Update the profile and set isEmailValidated to `true`
    const errorOrUpdatedProfile = await profileModel
      .update({
        ...existingProfile,
        isEmailValidated: true
      })
      .run();

    if (isLeft(errorOrUpdatedProfile)) {
      context.log.error(
        `${logPrefix}|Error updating profile|ERROR=${errorOrUpdatedProfile.value}`
      );
      return ResponseSeeOtherRedirect(
        vFailureUrl(ValidationErrors.GENERIC_ERROR)
      );
    }

    context.log.verbose(`${logPrefix}|The profile has been updated`);
    return ResponseSeeOtherRedirect(
      validationSuccessUrl(validationCallbackUrl)
    );
  };
}

/**
 * Wraps a ValidateProfileEmail handler inside an Express request handler.
 */
export function ValidateProfileEmail(
  tableService: TableService,
  validationTokensTableName: string,
  profileModel: ProfileModel,
  validationCallbackUrl: ValidUrl,
  timeStampGenerator: () => number
): express.RequestHandler {
  const handler = ValidateProfileEmailHandler(
    tableService,
    validationTokensTableName,
    profileModel,
    validationCallbackUrl,
    timeStampGenerator
  );

  const middlewaresWrap = withRequestMiddlewares(
    ContextMiddleware(),
    TokenQueryParamMiddleware
  );
  return wrapRequestHandler(middlewaresWrap(handler));
}
