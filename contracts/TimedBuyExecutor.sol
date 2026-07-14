// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Executes a prebuilt 42 Router call atomically after a Unix timestamp.
contract TimedBuyExecutor {
    error NotOwner();
    error NotOperator();
    error ReentrantCall();
    error TooEarly(uint256 currentTimestamp, uint256 notBeforeTimestamp);
    error TokenCallFailed();
    error RouterCallFailed(bytes reason);
    error ZeroAddress();

    address public constant ROUTER = 0x888888886619275d33c00D3BC62DF94D700DCD42;
    address public constant COLLATERAL = 0x55d398326f99059fF775485246999027B3197955;

    address public owner;
    mapping(address => bool) public operators;
    uint256 private unlocked = 1;

    constructor() {
        owner = msg.sender;
        operators[msg.sender] = true;
        if (!IERC20(COLLATERAL).approve(ROUTER, type(uint256).max)) revert TokenCallFailed();
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (!operators[msg.sender]) revert NotOperator();
        _;
    }

    modifier nonReentrant() {
        if (unlocked != 1) revert ReentrantCall();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    function executeAfter(
        uint256 notBeforeTimestamp,
        uint256 collateralAmount,
        bytes calldata routerCalldata
    ) external onlyOperator nonReentrant {
        if (block.timestamp < notBeforeTimestamp) {
            revert TooEarly(block.timestamp, notBeforeTimestamp);
        }
        if (!IERC20(COLLATERAL).transferFrom(msg.sender, address(this), collateralAmount)) {
            revert TokenCallFailed();
        }
        (bool success, bytes memory result) = ROUTER.call(routerCalldata);
        if (!success) revert RouterCallFailed(result);
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        operators[operator] = allowed;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }

    function sweepCollateral(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (!IERC20(COLLATERAL).transfer(to, amount)) revert TokenCallFailed();
    }
}
